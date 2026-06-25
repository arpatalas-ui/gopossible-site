"""Address geocoding — LocationIQ primary with Nominatim fallback, biased toward Szczecin.

Features:
- Three-stage search: strict city bbox -> wider region bbox -> unbounded country.
- Distance validation: rejects pins farther than `max_km` from the depot.
- Mongo cache that self-heals stale entries that pre-date the city-prior fix.
- Address normalisation (mangled XLS encodings, missing space between street and number).
"""
import asyncio
import logging
import math
import re
import time
from typing import List, Optional, Tuple

import requests as http_lib

from .db import LOCATIONIQ_KEY, db
from .models import Stop, utc_now_iso


LOCATIONIQ_URL = "https://us1.locationiq.com/v1/search"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
GEO_UA = "KurierNawigacja/1.0 (courier app)"

# City priors — geocoding is biased toward the courier's home depot first.
_CITY_PRIORS = [
    {
        "match": ("szczecin", "szczećin", "szćzećin", "szczecin "),
        "name": "Szczecin",
        "viewbox": "14.40,53.55,14.72,53.32",       # tight Szczecin bbox (W,N,E,S)
        "wide_viewbox": "14.10,53.95,15.10,53.00",  # West Pomerania
        "center": (53.4285, 14.5528),
        "max_km": 35.0,
    },
]

_PL_TABLE = str.maketrans(
    "ąćęłńóśźżĄĆĘŁŃÓŚŹŻ",
    "acelnoszzACELNOSZZ",
)

_CITY_FIXES = {
    "szćzećin": "Szczecin",
    "szćzecin": "Szczecin",
    "szczećin": "Szczecin",
    "szczecin ": "Szczecin",
}


def _strip_pl(s: str) -> str:
    return (s or "").translate(_PL_TABLE)


def _normalize_address(addr: str) -> str:
    if not addr:
        return addr
    s = addr.strip()
    for bad, good in _CITY_FIXES.items():
        s = re.sub(re.escape(bad), good, s, flags=re.IGNORECASE)
    s = re.sub(r"([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż])(\d)", r"\1 \2", s)
    s = re.sub(r"(\d+)\s*/\s*(?=$|,)", r"\1", s)
    s = re.sub(r"(\b\d+[A-Za-z]?\b)\s+\1\b[\w/]*", r"\1", s)
    s = re.sub(r"\s+", " ", s).strip(" ,;-")
    return s


def _street_only(addr: str) -> str:
    if not addr:
        return addr
    s = _normalize_address(addr)
    s = re.sub(r"(\d+[A-Za-z]?)\s*/\s*[\w-]+", r"\1", s)
    s = re.sub(r"\b(lok|lok\.|m\.|mieszk\.?|bud\.?|kod:?).*$", "", s, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", s).strip(" ,;-")


def _haversine_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    lat1, lng1 = a
    lat2, lng2 = b
    r = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(x)))

# Public alias (used by tests)
_math_distance_km = _haversine_km


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
        r = http_lib.get(LOCATIONIQ_URL, params=params, headers={"Accept-Language": "pl"}, timeout=10)
        if r.status_code == 200:
            data = r.json()
            if data:
                return float(data[0]["lat"]), float(data[0]["lon"])
    except Exception:
        pass
    return None


def _nominatim_sync(addr: str) -> Optional[Tuple[float, float]]:
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


_LIQ_LOCK = asyncio.Lock()
_LAST_LIQ_CALL = 0.0
_NOMINATIM_LOCK = asyncio.Lock()
_LAST_NOMINATIM_CALL = 0.0


async def _locationiq_paced(query: str, viewbox: Optional[str] = None, bounded: bool = False) -> Optional[Tuple[float, float]]:
    global _LAST_LIQ_CALL
    async with _LIQ_LOCK:
        wait = 0.55 - (time.monotonic() - _LAST_LIQ_CALL)
        if wait > 0:
            await asyncio.sleep(wait)
        result = await asyncio.to_thread(_locationiq_sync, query, viewbox, bounded)
        _LAST_LIQ_CALL = time.monotonic()
    return result


async def _nominatim_paced(query: str) -> Optional[Tuple[float, float]]:
    global _LAST_NOMINATIM_CALL
    async with _NOMINATIM_LOCK:
        wait = 1.1 - (time.monotonic() - _LAST_NOMINATIM_CALL)
        if wait > 0:
            await asyncio.sleep(wait)
        result = await asyncio.to_thread(_nominatim_sync, query)
        _LAST_NOMINATIM_CALL = time.monotonic()
    return result


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


async def geocode_one(addr: str) -> Optional[Tuple[float, float]]:
    """Cache-aware geocoder with Szczecin city-prior bias."""
    if not addr:
        return None
    norm = _normalize_address(addr)
    relaxed = _street_only(addr)
    prior = _detect_city_prior(norm) or _detect_city_prior(addr)

    def _accept(coords: Tuple[float, float]) -> bool:
        if not prior:
            return True
        return _haversine_km(coords, prior["center"]) <= prior["max_km"]

    cached = await _cache_lookup(addr)
    if cached and _accept(cached):
        return cached
    if cached and not _accept(cached):
        try:
            await db.geocode_cache.delete_one({"_id": _norm_addr(addr)})
        except Exception:
            pass

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

    if LOCATIONIQ_KEY:
        if prior:
            for q in queries:
                coords = await _locationiq_paced(q, viewbox=prior["viewbox"], bounded=True)
                if coords and _accept(coords):
                    await _cache_store(addr, *coords)
                    return coords
            for q in queries:
                coords = await _locationiq_paced(q, viewbox=prior["wide_viewbox"], bounded=True)
                if coords and _accept(coords):
                    await _cache_store(addr, *coords)
                    return coords
        for q in queries:
            coords = await _locationiq_paced(q)
            if coords and _accept(coords):
                await _cache_store(addr, *coords)
                return coords

    for q in queries:
        coords = await _nominatim_paced(q)
        if coords and _accept(coords):
            await _cache_store(addr, *coords)
            return coords
    return None


async def geocode_stops(stops: List[Stop]) -> None:
    for s in stops:
        if s.address and s.lat is None:
            coords = await geocode_one(s.address)
            if coords:
                s.lat, s.lng = coords


async def background_geocode_route(route_id: str) -> None:
    """Geocode stops in the background and persist each success immediately."""
    try:
        logging.info("Background geocode started for %s", route_id)
        doc = await db.routes.find_one({"id": route_id}, {"_id": 0})
        if not doc:
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
