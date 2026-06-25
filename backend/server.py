from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import asyncio
import base64
import io
import json
import logging
import re
import uuid
import tempfile
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Tuple
from datetime import datetime, timezone

import pandas as pd
import requests as http_lib
from emergentintegrations.llm.chat import LlmChat, UserMessage, FileContentWithMimeType


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

EMERGENT_LLM_KEY = os.environ.get('EMERGENT_LLM_KEY')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

app = FastAPI()
api_router = APIRouter(prefix="/api")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------- Models ----------
class Stop(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    order: int
    address: str
    recipient_name: str = ""
    phone: str = ""
    package_numbers: List[str] = []
    cod_amount: float = 0.0
    extra_fees: float = 0.0
    is_cod: bool = False
    lat: Optional[float] = None
    lng: Optional[float] = None
    status: str = "pending"  # pending | delivered | absent
    photo_base64: Optional[str] = None
    signature_base64: Optional[str] = None
    note: Optional[str] = None
    completed_at: Optional[str] = None


class Route(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    created_at: str = Field(default_factory=utc_now_iso)
    stops: List[Stop] = []


class ManifestUploadRequest(BaseModel):
    pdf_base64: str
    name: Optional[str] = None


class StopDeliverRequest(BaseModel):
    photo_base64: Optional[str] = None
    signature_base64: Optional[str] = None


class StopAbsentRequest(BaseModel):
    note: Optional[str] = None


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
3. Polskie znaki (ł, ś, ż, ć, ń, ó, ą, ę) bywają popsute w PDF — odtwórz je tam gdzie się da (np. "Wi niewski" → "Wiśniewski", "Dor czenie" → "Doręczenie", "Grayna" → "Grażyna", "ZAK AD" → "ZAKŁAD").
4. Zwróć WYŁĄCZNIE poprawny JSON. Żadnego komentarza, żadnego markdown.

FORMAT WYJŚCIA:
{
  "stops": [
    {
      "order": 1,
      "address": "Andrzeja Antosiewicza 1, Szczecin",
      "recipient_name": "Kacper Wiśniewski (P.H.U. AWO)",
      "phone": "",
      "package_numbers": ["PX7565795355"],
      "is_cod": false,
      "cod_amount": 0
    }
  ]
}
"""


# ---------- Geocoding (Photon by Komoot, with Nominatim fallback) ----------
PHOTON_URL = "https://photon.komoot.io/api/"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
GEO_UA = "KurierNawigacja/1.0 (courier app)"


def _geocode_sync(addr: str) -> Optional[Tuple[float, float]]:
    """OSM Nominatim lookup. Tries the address as-is, then with Polish
    diacritics stripped (XLS reports sometimes ship mangled diacritics)."""
    if not addr:
        return None
    queries = [addr + ", Polska", addr]
    if "," in addr:
        parts = [p.strip() for p in addr.split(",") if p.strip()]
        if len(parts) >= 2:
            queries.append(", ".join(parts[-2:]) + ", Polska")

    # Diacritic-stripped variants — rescue badly encoded city/street names.
    stripped = _strip_pl(addr)
    if stripped != addr:
        queries.append(stripped + ", Polska")
        if "," in stripped:
            sparts = [p.strip() for p in stripped.split(",") if p.strip()]
            if len(sparts) >= 2:
                queries.append(", ".join(sparts[-2:]) + ", Polska")

    seen = set()
    for q in queries:
        if q in seen:
            continue
        seen.add(q)
        try:
            r = http_lib.get(
                NOMINATIM_URL,
                params={"q": q, "format": "json", "limit": 1, "countrycodes": "pl"},
                headers={"User-Agent": GEO_UA, "Accept-Language": "pl"},
                timeout=10,
            )
            if r.status_code != 200:
                continue
            data = r.json()
            if data:
                return float(data[0]["lat"]), float(data[0]["lon"])
        except Exception:
            continue
    return None


def _norm_addr(addr: str) -> str:
    return " ".join((addr or "").lower().split())


async def _cache_lookup(addr: str) -> Optional[Tuple[float, float]]:
    doc = await db.geocode_cache.find_one({"_id": _norm_addr(addr)}, {"_id": 0, "lat": 1, "lng": 1})
    if doc and doc.get("lat") is not None and doc.get("lng") is not None:
        return float(doc["lat"]), float(doc["lng"])
    return None


async def _cache_store(addr: str, lat: float, lng: float) -> None:
    try:
        await db.geocode_cache.update_one(
            {"_id": _norm_addr(addr)},
            {"$set": {"lat": lat, "lng": lng, "saved_at": utc_now_iso()}},
            upsert=True,
        )
    except Exception:
        pass


async def geocode_stops(stops: List["Stop"]) -> None:
    """Geocode all stops with cache + politeness limit for Nominatim."""
    sem = asyncio.Semaphore(3)

    async def _g(s: "Stop") -> None:
        if not s.address:
            return
        cached = await _cache_lookup(s.address)
        if cached:
            s.lat, s.lng = cached
            return
        async with sem:
            coords = await asyncio.to_thread(_geocode_sync, s.address)
            if coords:
                s.lat, s.lng = coords
                await _cache_store(s.address, *coords)

    await asyncio.gather(*[_g(s) for s in stops])


async def _background_geocode_route(route_id: str) -> None:
    """Geocode + persist coordinates for a route in the background.

    Runs detached from the upload request so the client receives an immediate
    response while geocoding 100+ addresses (which can take 30-60 s) finishes
    behind the scenes. Subsequent GET /api/routes/{id} calls pick up the
    coordinates as they are written.
    """
    try:
        logging.info("Background geocode started for %s", route_id)
        doc = await db.routes.find_one({"id": route_id}, {"_id": 0})
        if not doc:
            logging.warning("Background geocode: route %s not found", route_id)
            return
        stops = [Stop(**s) for s in doc.get("stops", [])]
        await geocode_stops(stops)
        ok = sum(1 for s in stops if s.lat is not None)
        await db.routes.update_one(
            {"id": route_id},
            {"$set": {"stops": [s.model_dump() for s in stops]}},
        )
        logging.info("Background geocode finished for %s (%d/%d stops)", route_id, ok, len(stops))
    except Exception:
        logging.exception("Background geocode failed for %s", route_id)


# Strong references prevent the task from being garbage-collected before it completes.
_BG_TASKS: set = set()


def _spawn_background(coro):
    task = asyncio.create_task(coro)
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)
    return task


# ---------- XLS / XLSX manifest parser (Polish KSIĘGA ODDAWCZA report) ----------
PHONE_RE = re.compile(r"(?:\+?48[\s\-]?)?(\d{3}[\s\-]?\d{3}[\s\-]?\d{3})")

# Tokens that strongly hint a segment is a street (used to bias the recipient/address split).
_STREET_HINTS = re.compile(r"\b(ul\.|al\.|pl\.|os\.|aleja|aleje|plac|osiedle|skwer|rondo|bulwar)\b", re.IGNORECASE)
_HOUSE_NR_RE = re.compile(r"\b\d+[A-Za-z]?(?:\s*[/\-]\s*\d+[A-Za-z]?)?\b")

# Polish diacritic stripper — used as a geocoder fallback because some XLS reports
# come with mangled encodings (e.g. "Szćzećin" instead of "Szczecin").
_PL_TABLE = str.maketrans(
    "ąćęłńóśźżĄĆĘŁŃÓŚŹŻ",
    "acelnoszzACELNOSZZ",
)


def _strip_pl(s: str) -> str:
    return (s or "").translate(_PL_TABLE)


def _split_recipient_address(text: str) -> Tuple[str, str]:
    """Heuristic split of 'ADRESAT' column into (recipient_name, address).

    Strategy: scan comma-separated segments and find the first segment that
    looks like a street (contains a house number or street keyword). The
    segment immediately BEFORE that is treated as the city, and everything
    before the city is the recipient (so company names with internal commas
    like 'Acme, Sp. z o.o.' stay intact).
    """
    parts = [p.strip() for p in (text or "").split(",") if p.strip()]
    if len(parts) <= 1:
        return (text or "").strip(), ""

    street_idx = None
    for i, p in enumerate(parts):
        if _STREET_HINTS.search(p) or _HOUSE_NR_RE.search(p):
            street_idx = i
            break

    if street_idx is None or street_idx == 0:
        # Fall back to first-comma split when we can't find a street segment.
        return parts[0], ", ".join(parts[1:])

    # Segment before the street is the city. Everything before that is the recipient.
    city_idx = street_idx - 1
    recipient = ", ".join(parts[:city_idx]) if city_idx > 0 else parts[0]
    address = ", ".join(parts[city_idx:])
    return recipient.strip(), address.strip()


def _parse_phone(text: str) -> Tuple[str, str]:
    """Extract a Polish phone number from a free-form text. Returns (phone, text_without_phone)."""
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
    # Strip orphaned 'tel.', 'telefon', 'nr', and trailing punctuation around removed phone.
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


def parse_xls_manifest(file_bytes: bytes) -> List["Stop"]:
    """Parse the 'KSIĘGA ODDAWCZA WYDANYCH PRZESYŁEK' Excel report.

    Column layout (0-indexed) extracted from the user's sample file:
      col 1   -> ordinal number
      col 2   -> package tracking number (Numer nadawczy)
      col 18  -> ADRESAT: 'Recipient Name, City, Street ...' (sometimes phone inside)
      col 25  -> Kwota do zainkasowania — złote
      col 26  -> Kwota do zainkasowania — grosze
      col 28  -> Opłaty doręczeń i inne — złote
      col 29  -> Opłaty doręczeń i inne — grosze
      col 32  -> Uwagi (contains 'pobr' marker when COD)
    The data starts at the row right after a marker row that has 'Numer nadawczy'.
    """
    # First detect xls (CFB header) vs xlsx (PK zip)
    try:
        df = pd.read_excel(io.BytesIO(file_bytes), engine="xlrd", header=None, dtype=object)
    except Exception:
        df = pd.read_excel(io.BytesIO(file_bytes), engine="openpyxl", header=None, dtype=object)

    # Locate header row index (look for "Numer nadawczy")
    header_row = None
    for i in range(min(40, len(df))):
        row = df.iloc[i].fillna("").astype(str).tolist()
        joined = " ".join(row).lower()
        if "numer nadawczy" in joined and "adresat" in joined:
            header_row = i
            break
    if header_row is None:
        raise ValueError("Nie rozpoznano nagłówków raportu (brak 'Numer nadawczy' / 'ADRESAT')")

    data_start = header_row + 4  # header(+1), units row(+1), index markers(+2)
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

        # Phone first (so we strip it before splitting recipient/address).
        phone, adresat_str = _parse_phone(adresat_str)

        # Split recipient from address using the street-aware heuristic.
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
    # strip code fences if any
    if "```" in txt:
        parts = txt.split("```")
        for p in parts:
            p2 = p.strip()
            if p2.lower().startswith("json"):
                p2 = p2[4:].strip()
            if p2.startswith("{"):
                txt = p2
                break
    # try direct
    try:
        return json.loads(txt)
    except Exception:
        pass
    # try to find first { and last }
    start = txt.find("{")
    end = txt.rfind("}")
    if start >= 0 and end > start:
        return json.loads(txt[start:end + 1])
    raise ValueError("Nie udało się zdekodować odpowiedzi JSON od AI")


# ---------- Routes ----------
@api_router.get("/")
async def root():
    return {"message": "Courier API ok"}


@api_router.post("/manifest/upload")
async def upload_manifest(req: ManifestUploadRequest):
    try:
        file_bytes = base64.b64decode(req.pdf_base64)
    except Exception:
        raise HTTPException(status_code=400, detail="Nieprawidłowy plik (base64)")

    if len(file_bytes) < 100:
        raise HTTPException(status_code=400, detail="Plik jest zbyt mały")

    head = file_bytes[:8]
    is_xls = head[:4] == b"\xd0\xcf\x11\xe0"        # OLE2 compound (xls)
    is_xlsx = head[:4] == b"PK\x03\x04"             # zip-based (xlsx)
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

    name = (req.name or "").strip() or f"Trasa {datetime.now(timezone.utc).strftime('%d.%m.%Y %H:%M')}"
    route = Route(name=name, stops=stops)
    await db.routes.insert_one(route.model_dump())

    # Geocode in the background so the client gets the route immediately.
    # 100+ Photon lookups can take ~30-60 s and easily exceed ingress timeouts.
    _spawn_background(_background_geocode_route(route.id))

    return route.model_dump()


@api_router.get("/routes")
async def list_routes():
    routes = await db.routes.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    # Strip heavy fields for list view
    for r in routes:
        for s in r.get("stops", []):
            s.pop("photo_base64", None)
            s.pop("signature_base64", None)
    return routes


@api_router.get("/routes/{route_id}")
async def get_route(route_id: str):
    route = await db.routes.find_one({"id": route_id}, {"_id": 0})
    if not route:
        raise HTTPException(status_code=404, detail="Trasa nie znaleziona")
    # also strip heavy fields for stops list — full data lives on stop endpoint
    for s in route.get("stops", []):
        s.pop("photo_base64", None)
        s.pop("signature_base64", None)
    return route


@api_router.delete("/routes/{route_id}")
async def delete_route(route_id: str):
    res = await db.routes.delete_one({"id": route_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404)
    return {"ok": True}


@api_router.post("/routes/{route_id}/regeocode")
async def regeocode_route(route_id: str):
    """Re-run Nominatim geocoding for every stop on a route. Useful for routes saved before the geocoder existed."""
    route = await db.routes.find_one({"id": route_id}, {"_id": 0})
    if not route:
        raise HTTPException(status_code=404)
    stops = [Stop(**s) for s in route.get("stops", [])]
    await geocode_stops(stops)
    await db.routes.update_one(
        {"id": route_id},
        {"$set": {"stops": [s.model_dump() for s in stops]}},
    )
    return {"ok": True, "stops": len(stops), "geocoded": sum(1 for s in stops if s.lat is not None)}


@api_router.get("/routes/{route_id}/stops/{stop_id}")
async def get_stop(route_id: str, stop_id: str):
    route = await db.routes.find_one({"id": route_id}, {"_id": 0})
    if not route:
        raise HTTPException(status_code=404)
    for s in route.get("stops", []):
        if s["id"] == stop_id:
            return s
    raise HTTPException(status_code=404, detail="Stop nie znaleziony")


@api_router.post("/routes/{route_id}/stops/{stop_id}/deliver")
async def deliver_stop(route_id: str, stop_id: str, req: StopDeliverRequest):
    result = await db.routes.update_one(
        {"id": route_id, "stops.id": stop_id},
        {"$set": {
            "stops.$.status": "delivered",
            "stops.$.photo_base64": req.photo_base64,
            "stops.$.signature_base64": req.signature_base64,
            "stops.$.completed_at": utc_now_iso(),
            "stops.$.note": None,
        }},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404)
    return {"ok": True}


@api_router.post("/routes/{route_id}/stops/{stop_id}/absent")
async def absent_stop(route_id: str, stop_id: str, req: StopAbsentRequest):
    result = await db.routes.update_one(
        {"id": route_id, "stops.id": stop_id},
        {"$set": {
            "stops.$.status": "absent",
            "stops.$.note": req.note,
            "stops.$.completed_at": utc_now_iso(),
        }},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404)
    return {"ok": True}


@api_router.post("/routes/{route_id}/stops/{stop_id}/reset")
async def reset_stop(route_id: str, stop_id: str):
    result = await db.routes.update_one(
        {"id": route_id, "stops.id": stop_id},
        {"$set": {
            "stops.$.status": "pending",
            "stops.$.photo_base64": None,
            "stops.$.signature_base64": None,
            "stops.$.completed_at": None,
            "stops.$.note": None,
        }},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404)
    return {"ok": True}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
