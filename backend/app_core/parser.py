"""Manifest parsers — XLS/XLSX (Polish KSIĘGA ODDAWCZA) + PDF (AI via Gemini Flash)."""
import asyncio
import base64
import io
import json
import logging
import os
import re
import tempfile
import uuid
from datetime import datetime, timezone
from typing import List, Optional, Tuple

import pandas as pd
from fastapi import HTTPException
from emergentintegrations.llm.chat import LlmChat, UserMessage, FileContentWithMimeType

from .db import EMERGENT_LLM_KEY
from .models import Stop, Route


PARSING_SYSTEM_PROMPT = """Jesteś parserem polskich manifestów kurierskich (m.in. format 4BIS / Spoke).
Manifest to PDF z listą paczek w formie tabeli. Każda paczka ma:
- numer porządkowy (1, 2, 3 ... aż do "Stops: N" z nagłówka)
- imię i nazwisko / nazwa odbiorcy (czasem w wielu liniach)
- adres dostawy (ulica, numer, mieszkanie, miasto, ", Poland")
- linia trackingowa z numerem paczki (np. PX7565795355, CD120793236BE, 00359007733820257041) i flagami statusu

FLAGI STATUSU W LINII TRACKINGOWEJ:
- "pobr" lub ". pobr;" lub " pobr;" → przesyłka za pobraniem (POBRANIE). Ustaw "is_cod": true.
- "Awizo" → awizacja
- "Zwrot" → zwrot
- "OwPZ" / "OwAPM" / "Dostarczenie do punktu" / "Dostarczenie do APM" → paczkomat / punkt
- "Dor czenie" / "Doręczenie" / "Dorczenie" → standardowa dostawa
- "Nadanie u kuriera" → tylko status w systemie, nie zmienia parsowania

DLA KAŻDEJ PACZKI WYDOBĄDŹ:
- "order": numer porządkowy z manifestu (int)
- "address": pełny adres BEZ ", Poland" na końcu. Zachowaj nr ulicy, nr mieszkania, miasto.
- "recipient_name": pełne imię i nazwisko (jeśli wieloliniowe — połącz spacją). Jeśli przed nazwiskiem widnieje nazwa firmy, możesz dopisać firmę w nawiasie po nazwisku.
- "phone": "" (numery telefonów NIE występują w tym manifeście)
- "package_numbers": lista numerów paczek (np. ["PX7565795355"]). Jeden wiersz = zwykle jeden numer.
- "is_cod": true jeśli w linii trackingowej jest słowo "pobr"; w przeciwnym razie false
- "cod_amount": 0 (kwoty NIE są pokazane w tym manifeście)

KRYTYCZNE ZASADY:
1. ZACHOWAJ DOKŁADNĄ KOLEJNOŚĆ Z MANIFESTU — platforma źródłowa już zoptymalizowała trasę, NIE sortuj ponownie.
2. WYDOBĄDŹ WSZYSTKIE STOPY — nagłówek mówi ile ich jest ("Stops: 104"). Nie pomijaj żadnego.
3. Polskie znaki (ł, ś, ż, ć, ń, ó, ą, ę) bywają popsute w PDF — odtwórz je tam gdzie się da.
4. Zwróć WYŁĄCZNIE poprawny JSON. Żadnego komentarza, żadnego markdown.

FORMAT WYJŚCIA: { "stops": [...] }
"""

PHONE_RE = re.compile(r"(?:\+?48[\s\-]?)?(\d{3}[\s\-]?\d{3}[\s\-]?\d{3})")
_STREET_HINTS = re.compile(r"\b(ul\.|al\.|pl\.|os\.|aleja|aleje|plac|osiedle|skwer|rondo|bulwar)\b", re.IGNORECASE)
_HOUSE_NR_RE = re.compile(r"\b\d+[A-Za-z]?(?:\s*[/\-]\s*\d+[A-Za-z]?)?\b")


def _split_recipient_address(text: str) -> Tuple[str, str]:
    parts = [p.strip() for p in (text or "").split(",") if p.strip()]
    if len(parts) <= 1:
        return (text or "").strip(), ""

    street_idx = None
    for i, p in enumerate(parts):
        if _STREET_HINTS.search(p) or _HOUSE_NR_RE.search(p):
            street_idx = i
            break

    if street_idx is None or street_idx == 0:
        return parts[0], ", ".join(parts[1:])

    city_idx = street_idx - 1
    recipient = ", ".join(parts[:city_idx]) if city_idx > 0 else parts[0]
    address = ", ".join(parts[city_idx:])
    return recipient.strip(), address.strip()


def _parse_phone(text: str) -> Tuple[str, str]:
    if not text:
        return "", text
    m = PHONE_RE.search(text)
    if not m:
        return "", text
    digits = re.sub(r"\D", "", m.group(0))
    if len(digits) < 9:
        return "", text
    if len(digits) == 9:
        phone = f"+48 {digits[:3]} {digits[3:6]} {digits[6:]}"
    else:
        phone = "+" + digits
    cleaned = (text[:m.start()] + text[m.end():])
    cleaned = re.sub(r"[,;:]?\s*(tel(?:efon)?\.?|nr\.?)\s*[,;:]?\s*", ", ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*,\s*,\s*", ", ", cleaned)
    cleaned = cleaned.strip(" ,;:.-")
    return phone, cleaned


def _zlgr_to_float(zl, gr) -> float:
    try:
        z = float(zl) if zl is not None and str(zl).strip() not in ("", "nan") else 0.0
    except Exception:
        z = 0.0
    try:
        g = float(gr) if gr is not None and str(gr).strip() not in ("", "nan") else 0.0
    except Exception:
        g = 0.0
    return round(z + g / 100.0, 2)


def parse_xls_manifest(file_bytes: bytes) -> List[Stop]:
    """Parse the 'KSIĘGA ODDAWCZA WYDANYCH PRZESYŁEK' Excel report."""
    try:
        df = pd.read_excel(io.BytesIO(file_bytes), engine="xlrd", header=None, dtype=object)
    except Exception:
        df = pd.read_excel(io.BytesIO(file_bytes), engine="openpyxl", header=None, dtype=object)

    header_row = None
    for i in range(min(40, len(df))):
        row = df.iloc[i].fillna("").astype(str).tolist()
        joined = " ".join(row).lower()
        if "numer nadawczy" in joined and "adresat" in joined:
            header_row = i
            break
    if header_row is None:
        raise ValueError("Nie rozpoznano nagłówków raportu (brak 'Numer nadawczy' / 'ADRESAT')")

    data_start = header_row + 4
    stops: List[Stop] = []
    order_idx = 0
    for i in range(data_start, len(df)):
        row = df.iloc[i]
        pkg = row.get(2)
        adresat = row.get(18)
        if pkg is None or str(pkg).strip() in ("", "nan"):
            continue
        if adresat is None or str(adresat).strip() in ("", "nan"):
            continue
        order_idx += 1
        pkg_str = str(pkg).strip()
        adresat_str = str(adresat).strip()
        phone, adresat_str = _parse_phone(adresat_str)
        recipient, address = _split_recipient_address(adresat_str)
        cod = _zlgr_to_float(row.get(25), row.get(26))
        fees = _zlgr_to_float(row.get(28), row.get(29))
        notes = ""
        try:
            notes = str(row.get(32) or "").strip()
        except Exception:
            notes = ""
        is_cod = ("pobr" in notes.lower()) or cod > 0
        stops.append(Stop(
            order=order_idx,
            address=address or adresat_str,
            recipient_name=recipient,
            phone=phone,
            package_numbers=[pkg_str],
            cod_amount=cod,
            extra_fees=fees,
            is_cod=is_cod,
        ))
    return stops


def _extract_json(raw: str) -> dict:
    txt = raw.strip()
    if "```" in txt:
        parts = txt.split("```")
        for p in parts:
            p2 = p.strip()
            if p2.lower().startswith("json"):
                p2 = p2[4:].strip()
            if p2.startswith("{"):
                txt = p2
                break
    try:
        return json.loads(txt)
    except Exception:
        pass
    start = txt.find("{")
    end = txt.rfind("}")
    if start >= 0 and end > start:
        return json.loads(txt[start:end + 1])
    raise ValueError("Nie udało się zdekodować odpowiedzi JSON od AI")


async def parse_manifest_to_route(file_b64: str, name: Optional[str]) -> Route:
    """Decode + parse a manifest file (PDF/XLS/XLSX) into a Route object."""
    try:
        file_bytes = base64.b64decode(file_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Nieprawidłowy plik (base64)")

    if len(file_bytes) < 100:
        raise HTTPException(status_code=400, detail="Plik jest zbyt mały")

    head = file_bytes[:8]
    is_xls = head[:4] == b"\xd0\xcf\x11\xe0"
    is_xlsx = head[:4] == b"PK\x03\x04"
    is_pdf = head[:4] == b"%PDF"

    stops: List[Stop] = []

    if is_xls or is_xlsx:
        try:
            stops = await asyncio.to_thread(parse_xls_manifest, file_bytes)
        except Exception as e:
            logging.exception("XLS parse failed")
            raise HTTPException(status_code=400, detail=f"Błąd parsowania pliku Excel: {e}")
        if not stops:
            raise HTTPException(status_code=400, detail="Nie znaleziono paczek w raporcie Excel")
    elif is_pdf:
        if not EMERGENT_LLM_KEY:
            raise HTTPException(status_code=500, detail="LLM key nieskonfigurowany")
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
                tmp.write(file_bytes)
                tmp_path = tmp.name
            chat = LlmChat(
                api_key=EMERGENT_LLM_KEY,
                session_id=str(uuid.uuid4()),
                system_message=PARSING_SYSTEM_PROMPT,
            ).with_model("gemini", "gemini-2.5-flash").with_params(max_tokens=32000)
            pdf_file = FileContentWithMimeType(file_path=tmp_path, mime_type="application/pdf")
            response = await chat.send_message(UserMessage(
                text="Sparsuj ten manifest kuriera i zwróć JSON z listą WSZYSTKICH stopów w dokładnej kolejności z manifestu.",
                file_contents=[pdf_file],
            ))
        except HTTPException:
            raise
        except Exception as e:
            logging.exception("Manifest parse failed")
            raise HTTPException(status_code=500, detail=f"Błąd parsowania PDF przez AI: {e}")
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass

        raw_text = response if isinstance(response, str) else getattr(response, "content", str(response))
        try:
            data = _extract_json(raw_text)
        except Exception as e:
            logging.error("AI raw response: %s", raw_text[:1000])
            raise HTTPException(status_code=500, detail=f"Niepoprawna odpowiedź AI: {e}")

        stops_raw = data.get("stops", []) if isinstance(data, dict) else []
        if not stops_raw:
            raise HTTPException(status_code=400, detail="Nie znaleziono paczek w manifeście")

        for i, s in enumerate(stops_raw):
            try:
                cod = float(s.get("cod_amount", 0) or 0)
            except Exception:
                cod = 0.0
            try:
                order_val = int(s.get("order", i + 1))
            except Exception:
                order_val = i + 1
            is_cod_flag = bool(s.get("is_cod", False)) or cod > 0
            stops.append(Stop(
                order=order_val,
                address=str(s.get("address", "")).strip(),
                recipient_name=str(s.get("recipient_name", "")).strip(),
                phone=str(s.get("phone", "")).strip(),
                package_numbers=[str(x) for x in (s.get("package_numbers") or [])],
                cod_amount=cod,
                is_cod=is_cod_flag,
            ))
    else:
        raise HTTPException(status_code=400, detail="Nieobsługiwany format pliku (oczekiwany PDF, XLS lub XLSX)")

    final_name = (name or "").strip() or f"Trasa {datetime.now(timezone.utc).strftime('%d.%m.%Y %H:%M')}"
    return Route(name=final_name, stops=stops)
