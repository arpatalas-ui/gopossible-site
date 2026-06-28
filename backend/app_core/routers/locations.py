"""Courier GPS location pings.

- `POST /api/courier/locations` — called by the courier mobile app every 30 s while
  it's running in the foreground. Stores a tracking ping for the dispatcher.
- `GET  /api/courier/locations` — called by gopossible.pl with `X-Api-Key` to read
  the latest position of each courier (and optionally a small history window).

A TTL index on `created_at` keeps the collection lean (auto-deletes after 24 h).
"""
from datetime import datetime, timedelta, timezone
from typing import Optional, List

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, Field

from ..db import db, GOPOSSIBLE_API_KEY
from ..models import utc_now_iso

router = APIRouter()


class LocationPing(BaseModel):
    courier_id: str = ""           # may be empty until profile is set up
    courier_name: str = ""
    lat: float
    lng: float
    accuracy: Optional[float] = None
    speed: Optional[float] = None  # m/s
    heading: Optional[float] = None  # degrees (0-360)
    altitude: Optional[float] = None
    route_id: Optional[str] = None
    client_ts: Optional[str] = None  # ISO from device clock (optional)


_TTL_READY = False


async def _ensure_indexes():
    """Index on (courier_id, created_at) for fast latest-per-courier and 24h TTL cleanup."""
    global _TTL_READY
    if _TTL_READY:
        return
    try:
        await db.courier_locations.create_index([("courier_id", 1), ("created_at", -1)])
        # TTL — auto-delete entries older than 24h. Mongo runs cleanup ~every 60s.
        await db.courier_locations.create_index("created_at_dt", expireAfterSeconds=24 * 3600)
    except Exception:
        pass
    _TTL_READY = True


@router.post("/courier/locations")
async def post_location(ping: LocationPing):
    """Receive a GPS ping from the courier app. No auth — public endpoint that
    the mobile app calls repeatedly; we throttle by collection TTL.
    """
    await _ensure_indexes()
    now = datetime.now(timezone.utc)
    doc = ping.model_dump()
    doc["created_at"] = now.isoformat()
    doc["created_at_dt"] = now  # used for TTL index
    await db.courier_locations.insert_one(doc)
    return {"ok": True, "ts": doc["created_at"]}


@router.get("/courier/locations")
async def list_locations(
    x_api_key: Optional[str] = Header(default=None, alias="X-Api-Key"),
    since_minutes: int = Query(60, ge=1, le=1440, description="Look-back window in minutes (default 60)"),
    courier_id: Optional[str] = Query(None, description="Filter by a single courier"),
):
    """Called by gopossible.pl dispatcher to read recent courier positions.

    Auth: requires the same `X-Api-Key` as `/api/transfer/create`.

    Returns: latest ping per courier (when `courier_id` is omitted) or the full
    history for a single courier (when provided).
    """
    if not GOPOSSIBLE_API_KEY:
        raise HTTPException(status_code=500, detail="Integracja niedostępna — brak GOPOSSIBLE_API_KEY")
    if not x_api_key or x_api_key.strip() != GOPOSSIBLE_API_KEY:
        raise HTTPException(status_code=401, detail="Nieautoryzowany — niepoprawny X-Api-Key")

    since = datetime.now(timezone.utc) - timedelta(minutes=since_minutes)
    since_iso = since.isoformat()

    if courier_id:
        cursor = db.courier_locations.find(
            {"courier_id": courier_id, "created_at": {"$gte": since_iso}},
            {"_id": 0, "created_at_dt": 0},
        ).sort("created_at", -1).limit(500)
        return {"courier_id": courier_id, "pings": await cursor.to_list(500)}

    # Aggregate latest ping per courier_id within the window.
    pipeline = [
        {"$match": {"created_at": {"$gte": since_iso}}},
        {"$sort": {"created_at": -1}},
        {"$group": {
            "_id": "$courier_id",
            "latest": {"$first": "$$ROOT"},
        }},
        {"$replaceRoot": {"newRoot": "$latest"}},
        {"$project": {"_id": 0, "created_at_dt": 0}},
    ]
    couriers: List[dict] = []
    async for row in db.courier_locations.aggregate(pipeline):
        couriers.append(row)
    return {"since_minutes": since_minutes, "couriers": couriers}
