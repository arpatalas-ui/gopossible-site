from fastapi import FastAPI, APIRouter, HTTPException, Header
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
import time
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
LOCATIONIQ_KEY = os.environ.get('LOCATIONIQ_KEY')
GOPOSSIBLE_API_KEY = os.environ.get('GOPOSSIBLE_API_KEY')

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
    approved_at: Optional[str] = None
    stops: List[Stop] = []


class ManifestUploadRequest(BaseModel):
    pdf_base64: str
    name: Optional[str] = None


class StopDeliverRequest(BaseModel):
    photo_base64: Optional[str] = None
    signature_base64: Optional[str] = None


class StopAbsentRequest(BaseModel):
    note: Optional[str] = None


class StopAddressUpdateRequest(BaseModel):
    address: str


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


# ---------- Geocoding (LocationIQ primary, Nominatim fallback) ----------
LOCATIONIQ_URL = "https://us1.locationiq.com/v1/search"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
GEO_UA = "KurierNawigacja/1.0 (courier app)"

# City priors — used to bias geocoding toward the courier's home depot first.
# Each entry: (city_name_lower, (south, west, north, east), (lat, lng), radius_km)
# LocationIQ expects viewbox as "lon_left,lat_top,lon_right,lat_bottom" (W,N,E,S).
_CITY_PRIORS = [
    {
        "match": ("szczecin", "szczećin", "szćzećin", "szczecin "),
        "name": "Szczecin",
        "viewbox": "14.40,53.55,14.72,53.32",   # tight Szczecin bbox
        "wide_viewbox": "14.10,53.95,15.10,53.00",  # West Pomerania (~city + okolice)
        "center": (53.4285, 14.5528),
        "max_km": 35.0,  # reject pins farther than 35 km from Szczecin centre
    },
]


def _math_distance_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    import math
    lat1, lng1 = a
    lat2, lng2 = b
    r = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(x)))


def _detect_city_prior(addr: str) -> Optional[dict]:
    low = (addr or "").lower()
    for p in _CITY_PRIORS:
        for needle in p["match"]:
            if needle in low:
                return p
    return None


def _locationiq_sync(addr: str, viewbox: Optional[str] = None, bounded: bool = False) -> Optional[Tuple[float, float]]:
    if not addr or not LOCATIONIQ_KEY:
        return None
    try:
        params = {
            "key": LOCATIONIQ_KEY,
            "q": addr,
            "format": "json",
            "limit": 1,
            "countrycodes": "pl",
            "accept-language": "pl",
        }
        if viewbox:
            params["viewbox"] = viewbox
            if bounded:
                params["bounded"] = 1
        r = http_lib.get(
            LOCATIONIQ_URL,
            params=params,
            headers={"Accept-Language": "pl"},
            timeout=10,
        )
        if r.status_code == 200:
            data = r.json()
            if data:
                return float(data[0]["lat"]), float(data[0]["lon"])
    except Exception:
        pass
    return None


def _geocode_sync(addr: str) -> Optional[Tuple[float, float]]:
    """Single Nominatim query (one HTTP call). Callers handle pacing."""
    if not addr:
        return None
    try:
        r = http_lib.get(
            NOMINATIM_URL,
            params={"q": addr, "format": "json", "limit": 1, "countrycodes": "pl"},
            headers={"User-Agent": GEO_UA, "Accept-Language": "pl"},
            timeout=10,
        )
        if r.status_code != 200:
            return None
        data = r.json()
        if data:
            return float(data[0]["lat"]), float(data[0]["lon"])
    except Exception:
        pass
    return None


# LocationIQ free tier allows ~2 req/s; serialise with a 0.55 s gap to be safe.
_LIQ_LOCK = asyncio.Lock()
_LAST_LIQ_CALL = 0.0


async def _locationiq_paced(query: str, viewbox: Optional[str] = None, bounded: bool = False) -> Optional[Tuple[float, float]]:
    global _LAST_LIQ_CALL
    async with _LIQ_LOCK:
        now = time.monotonic()
        wait = 0.55 - (now - _LAST_LIQ_CALL)
        if wait > 0:
            await asyncio.sleep(wait)
        result = await asyncio.to_thread(_locationiq_sync, query, viewbox, bounded)
        _LAST_LIQ_CALL = time.monotonic()
    return result


# Nominatim (fallback): max 1 req/s.
_NOMINATIM_LOCK = asyncio.Lock()
_LAST_NOMINATIM_CALL = 0.0


async def _nominatim_paced(query: str) -> Optional[Tuple[float, float]]:
    global _LAST_NOMINATIM_CALL
    async with _NOMINATIM_LOCK:
        now = time.monotonic()
        wait = 1.1 - (now - _LAST_NOMINATIM_CALL)
        if wait > 0:
            await asyncio.sleep(wait)
        result = await asyncio.to_thread(_geocode_sync, query)
        _LAST_NOMINATIM_CALL = time.monotonic()
    return result


async def geocode_one(addr: str) -> Optional[Tuple[float, float]]:
    """Cache-aware geocoder with city-prior bias.

    Strategy (for an address that looks like Szczecin):
      1. Strict Szczecin bounding-box (bounded=1) — best match within city
      2. Wider West-Pomerania bounding-box (bounded=1) — covers suburbs
      3. Unbounded country-wide search (fallback)
    Results that fall too far from the city centre are rejected and the next
    candidate is tried, so we don't end up with pins in Wrocław/Kraków for a
    misspelled Szczecin street name.
    """
    if not addr:
        return None
    norm = _normalize_address(addr)
    relaxed = _street_only(addr)
    prior = _detect_city_prior(norm) or _detect_city_prior(addr)

    def _accept(coords: Tuple[float, float]) -> bool:
        if not prior:
            return True
        return _math_distance_km(coords, prior["center"]) <= prior["max_km"]

    cached = await _cache_lookup(addr)
    if cached and _accept(cached):
        return cached
    if cached and not _accept(cached):
        # Stale/poisoned cache entry from before the city-prior fix. Invalidate it.
        try:
            await db.geocode_cache.delete_one({"_id": _norm_addr(addr)})
        except Exception:
            pass

    # Build candidate query strings (most specific → most relaxed).
    queries: list = []
    seen = set()

    def _push(q: str) -> None:
        q = (q or "").strip(" ,;-")
        if q and q not in seen:
            seen.add(q)
            queries.append(q)

    for base in (norm, addr):
        _push(base + ", Polska")
        _push(base)
    if relaxed:
        _push(relaxed + ", Polska")
        _push(relaxed)
    if "," in norm:
        parts = [p.strip() for p in norm.split(",") if p.strip()]
        if len(parts) >= 2:
            _push(", ".join(parts[-2:]) + ", Polska")
    stripped = _strip_pl(norm)
    if stripped and stripped != norm:
        _push(stripped + ", Polska")

    def _accept(coords: Tuple[float, float]) -> bool:
        if not prior:
            return True
        return _math_distance_km(coords, prior["center"]) <= prior["max_km"]

    if LOCATIONIQ_KEY:
        # Stage 1 — strict city bbox
        if prior:
            for q in queries:
                coords = await _locationiq_paced(q, viewbox=prior["viewbox"], bounded=True)
                if coords and _accept(coords):
                    await _cache_store(addr, *coords)
                    return coords
            # Stage 2 — wider region bbox
            for q in queries:
                coords = await _locationiq_paced(q, viewbox=prior["wide_viewbox"], bounded=True)
                if coords and _accept(coords):
                    await _cache_store(addr, *coords)
                    return coords
        # Stage 3 — unbounded country-wide
        for q in queries:
            coords = await _locationiq_paced(q)
            if coords and _accept(coords):
                await _cache_store(addr, *coords)
                return coords

    # Nominatim fallback (no viewbox support here — just verify city distance)
    for q in queries:
        coords = await _nominatim_paced(q)
        if coords and _accept(coords):
            await _cache_store(addr, *coords)
            return coords
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
    """Geocode stops (legacy helper — used by /regeocode endpoint)."""
    for s in stops:
        if s.address and s.lat is None:
            coords = await geocode_one(s.address)
            if coords:
                s.lat, s.lng = coords


async def _background_geocode_route(route_id: str) -> None:
    """Geocode stops in the background and persist EACH success immediately,
    so map pins appear progressively while the courier is still on the screen."""
    try:
        logging.info("Background geocode started for %s", route_id)
        doc = await db.routes.find_one({"id": route_id}, {"_id": 0})
        if not doc:
            logging.warning("Background geocode: route %s not found", route_id)
            return
        stops = doc.get("stops", [])
        ok = 0
        for s in stops:
            if s.get("lat") is not None and s.get("lng") is not None:
                ok += 1
                continue
            coords = await geocode_one(s.get("address", ""))
            if coords:
                lat, lng = coords
                await db.routes.update_one(
                    {"id": route_id, "stops.id": s["id"]},
                    {"$set": {"stops.$.lat": lat, "stops.$.lng": lng}},
                )
                ok += 1
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


# Common Polish address typos / casing fixes seen in XLS reports.
_CITY_FIXES = {
    "szćzećin": "Szczecin",
    "szćzecin": "Szczecin",
    "szczećin": "Szczecin",
    "szczecin ": "Szczecin",
}


def _normalize_address(addr: str) -> str:
    """Clean up common XLS quirks before geocoding.

    - Fix mangled city names ("Szćzećin" → "Szczecin").
    - Insert missing space between street name and house number ("Montwiłła11/3" → "Montwiłła 11/3").
    - Drop trailing slashes and lone numbers ("Szarotki 23 23/u06" → "Szarotki 23").
    - Lower-case "kod:" suffix segments (postcode hints) are kept as-is.
    """
    if not addr:
        return addr
    s = addr.strip()
    # City typos (case-insensitive)
    for bad, good in _CITY_FIXES.items():
        s = re.sub(re.escape(bad), good, s, flags=re.IGNORECASE)
    # Insert space between letter and digit (street name → number glued together)
    s = re.sub(r"([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż])(\d)", r"\1 \2", s)
    # Collapse trailing "27/" or "11/" with no apartment
    s = re.sub(r"(\d+)\s*/\s*(?=$|,)", r"\1", s)
    # Collapse repeated number tokens like "Szarotki 23 23/u06" → "Szarotki 23"
    s = re.sub(r"(\b\d+[A-Za-z]?\b)\s+\1\b[\w/]*", r"\1", s)
    # Collapse whitespace
    s = re.sub(r"\s+", " ", s).strip(" ,;-")
    return s


def _street_only(addr: str) -> str:
    """Return street + city without apartment / flat suffix for a relaxed geocode pass."""
    if not addr:
        return addr
    s = _normalize_address(addr)
    # Drop everything after a "/" within a number token: "11/3" → "11"
    s = re.sub(r"(\d+[A-Za-z]?)\s*/\s*[\w-]+", r"\1", s)
    # Drop trailing extra tokens like "lok43", "VIp", "MARGRAF"
    s = re.sub(r"\b(lok|lok\.|m\.|mieszk\.?|bud\.?|kod:?).*$", "", s, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", s).strip(" ,;-")


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


async def _parse_manifest_to_route(file_b64: str, name: Optional[str]) -> Route:
    """Decode + parse a manifest file (PDF/XLS/XLSX) into a Route object.

    Raises HTTPException on validation/parse errors so endpoints can bubble them up.
    """
    try:
        file_bytes = base64.b64decode(file_b64)
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

    final_name = (name or "").strip() or f"Trasa {datetime.now(timezone.utc).strftime('%d.%m.%Y %H:%M')}"
    return Route(name=final_name, stops=stops)


# ---------- Routes ----------
@api_router.get("/")
async def root():
    return {"message": "Courier API ok"}


@api_router.post("/manifest/upload")
async def upload_manifest(req: ManifestUploadRequest):
    route = await _parse_manifest_to_route(req.pdf_base64, req.name)
    await db.routes.insert_one(route.model_dump())
    _spawn_background(_background_geocode_route(route.id))
    return route.model_dump()


# ---------- Transfer (gopossible.pl → mobile via QR) ----------
TRANSFER_EXPIRY_HOURS = 24


def _gen_transfer_code() -> str:
    """6-char alphanumeric code (uppercase, no ambiguous 0/O/1/I)."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    import secrets as _s
    return "".join(_s.choice(alphabet) for _ in range(6))


def _require_api_key(x_api_key: Optional[str]) -> None:
    if not GOPOSSIBLE_API_KEY:
        raise HTTPException(status_code=500, detail="Integracja niedostępna — brak GOPOSSIBLE_API_KEY")
    if not x_api_key or x_api_key.strip() != GOPOSSIBLE_API_KEY:
        raise HTTPException(status_code=401, detail="Nieautoryzowany — niepoprawny X-Api-Key")


@api_router.post("/transfer/create")
async def transfer_create(
    req: ManifestUploadRequest,
    x_api_key: Optional[str] = Header(default=None, alias="X-Api-Key"),
):
    """Called by gopossible.pl backend to push a parsed route to a courier's phone.

    Headers:
      X-Api-Key: <GOPOSSIBLE_API_KEY>
    Body: { pdf_base64, name? }   (same shape as /manifest/upload)
    Returns:
      {
        "transfer_code": "ABC234",        # show as text + inside QR
        "qr_payload":   "gopossible:transfer:ABC234",
        "route_id":     "...",            # already parsed and persisted
        "stops":        132,
        "expires_at":   "2026-06-26T18:..."
      }
    """
    _require_api_key(x_api_key)

    # Parse the manifest right away — fail fast if it's malformed.
    route = await _parse_manifest_to_route(req.pdf_base64, req.name)
    await db.routes.insert_one(route.model_dump())
    _spawn_background(_background_geocode_route(route.id))

    # Generate a unique pairing code. Retry on the (extremely rare) collision.
    code = _gen_transfer_code()
    for _ in range(5):
        existing = await db.transfers.find_one({"_id": code})
        if not existing:
            break
        code = _gen_transfer_code()

    # Add hours via timedelta
    from datetime import timedelta as _td
    real_expiry = datetime.now(timezone.utc) + _td(hours=TRANSFER_EXPIRY_HOURS)
    expires_iso = real_expiry.isoformat()

    await db.transfers.insert_one({
        "_id": code,
        "route_id": route.id,
        "created_at": utc_now_iso(),
        "expires_at": expires_iso,
        "claimed_at": None,
        "source": "gopossible.pl",
    })

    return {
        "transfer_code": code,
        "qr_payload": f"gopossible:transfer:{code}",
        "route_id": route.id,
        "stops": len(route.stops),
        "expires_at": expires_iso,
    }


@api_router.get("/transfer/{code}")
async def transfer_fetch(code: str):
    """Called by the mobile app after scanning the QR code on gopossible.pl.

    Returns the full route (geocoding may still be in progress — client polls
    the existing /api/routes/{route_id} endpoint for live updates).
    """
    code_norm = (code or "").strip().upper()
    if not code_norm:
        raise HTTPException(status_code=400, detail="Brak kodu transferu")

    transfer = await db.transfers.find_one({"_id": code_norm})
    if not transfer:
        raise HTTPException(status_code=404, detail="Kod nie istnieje lub wygasł")

    # Expiry check
    try:
        exp = datetime.fromisoformat(transfer["expires_at"])
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp < datetime.now(timezone.utc):
            raise HTTPException(status_code=410, detail="Kod wygasł — poproś dyspozytora o nowy")
    except HTTPException:
        raise
    except Exception:
        pass

    route = await db.routes.find_one({"id": transfer["route_id"]}, {"_id": 0})
    if not route:
        raise HTTPException(status_code=404, detail="Trasa już została usunięta")

    # Mark first claim (informational only — we don't lock the code so the courier
    # can re-scan after closing the app).
    if not transfer.get("claimed_at"):
        await db.transfers.update_one(
            {"_id": code_norm},
            {"$set": {"claimed_at": utc_now_iso()}},
        )

    # Strip heavy fields from list view (same as /routes/{id})
    for s in route.get("stops", []):
        s.pop("photo_base64", None)
        s.pop("signature_base64", None)

    return {
        "route": route,
        "transfer": {
            "code": code_norm,
            "created_at": transfer.get("created_at"),
            "claimed_at": transfer.get("claimed_at") or utc_now_iso(),
            "expires_at": transfer.get("expires_at"),
            "source": transfer.get("source"),
        },
    }


# Public, no-auth check (used by gopossible.pl to verify integration end-to-end).
@api_router.get("/transfer/{code}/status")
async def transfer_status(code: str):
    code_norm = (code or "").strip().upper()
    transfer = await db.transfers.find_one({"_id": code_norm}, {"_id": 0})
    if not transfer:
        raise HTTPException(status_code=404, detail="Brak kodu")
    return transfer



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


@api_router.post("/routes/{route_id}/approve")
async def approve_route(route_id: str):
    """Marks a route as approved by the courier (after reviewing pins on map).

    Idempotent — re-approval just refreshes the timestamp. Returns the updated
    approved_at so the client can render confirmation UI immediately.
    """
    ts = utc_now_iso()
    res = await db.routes.update_one(
        {"id": route_id},
        {"$set": {"approved_at": ts}},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Trasa nie znaleziona")
    return {"ok": True, "approved_at": ts}


@api_router.post("/routes/{route_id}/unapprove")
async def unapprove_route(route_id: str):
    """Reverts approval — used when courier wants to edit pins again before starting."""
    res = await db.routes.update_one(
        {"id": route_id},
        {"$set": {"approved_at": None}},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Trasa nie znaleziona")
    return {"ok": True}


@api_router.post("/routes/{route_id}/stops/{stop_id}/address")
async def update_stop_address(route_id: str, stop_id: str, req: StopAddressUpdateRequest):
    """Replace the recipient address for a single stop and re-geocode it.

    Used by the review screen when the courier spots an address pinned in the
    wrong city (e.g. mangled XLS encoding mapped the street to a different town).
    """
    new_addr = (req.address or "").strip()
    if not new_addr:
        raise HTTPException(status_code=400, detail="Adres nie może być pusty")

    # Geocode the corrected address. If it fails we still save the address but
    # leave lat/lng so the user knows it still needs review.
    coords = await geocode_one(new_addr)
    new_lat, new_lng = (coords if coords else (None, None))

    res = await db.routes.update_one(
        {"id": route_id, "stops.id": stop_id},
        {"$set": {
            "stops.$.address": new_addr,
            "stops.$.lat": new_lat,
            "stops.$.lng": new_lng,
        }},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Stop nie znaleziony")

    return {
        "ok": True,
        "address": new_addr,
        "lat": new_lat,
        "lng": new_lng,
        "geocoded": coords is not None,
    }


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
