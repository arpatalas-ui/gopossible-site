"""Route + stop endpoints: list, get, delete, deliver, absent, reset, approve, regeocode."""
import asyncio
from fastapi import APIRouter, HTTPException

from ..db import db
from ..models import (
    Stop, Route, ManifestUploadRequest,
    StopDeliverRequest, StopAbsentRequest, StopAddressUpdateRequest,
    utc_now_iso,
)
from ..parser import parse_manifest_to_route
from ..geocoder import background_geocode_route, geocode_one, geocode_stops
from ..report import build_route_pdf
from fastapi import Response, Query

router = APIRouter()

# Strong refs so asyncio tasks aren't GC'd mid-execution.
_BG_TASKS: set = set()


def _spawn_background(coro):
    task = asyncio.create_task(coro)
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)
    return task


@router.get("/")
async def root():
    return {"message": "Courier API ok"}


@router.post("/manifest/upload")
async def upload_manifest(req: ManifestUploadRequest):
    route = await parse_manifest_to_route(req.pdf_base64, req.name)
    await db.routes.insert_one(route.model_dump())
    _spawn_background(background_geocode_route(route.id))
    return route.model_dump()


@router.get("/routes")
async def list_routes():
    routes = await db.routes.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    for r in routes:
        for s in r.get("stops", []):
            s.pop("photo_base64", None)
            s.pop("signature_base64", None)
    return routes


@router.get("/routes/{route_id}")
async def get_route(route_id: str):
    route = await db.routes.find_one({"id": route_id}, {"_id": 0})
    if not route:
        raise HTTPException(status_code=404, detail="Trasa nie znaleziona")
    for s in route.get("stops", []):
        s.pop("photo_base64", None)
        s.pop("signature_base64", None)
    return route


@router.delete("/routes/{route_id}")
async def delete_route(route_id: str):
    res = await db.routes.delete_one({"id": route_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404)
    return {"ok": True}


@router.post("/routes/{route_id}/approve")
async def approve_route(route_id: str):
    ts = utc_now_iso()
    res = await db.routes.update_one({"id": route_id}, {"$set": {"approved_at": ts}})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Trasa nie znaleziona")
    return {"ok": True, "approved_at": ts}


@router.post("/routes/{route_id}/unapprove")
async def unapprove_route(route_id: str):
    res = await db.routes.update_one({"id": route_id}, {"$set": {"approved_at": None}})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Trasa nie znaleziona")
    return {"ok": True}


@router.post("/routes/{route_id}/stops/{stop_id}/address")
async def update_stop_address(route_id: str, stop_id: str, req: StopAddressUpdateRequest):
    new_addr = (req.address or "").strip()
    if not new_addr:
        raise HTTPException(status_code=400, detail="Adres nie może być pusty")
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
        "ok": True, "address": new_addr, "lat": new_lat, "lng": new_lng,
        "geocoded": coords is not None,
    }


@router.post("/routes/{route_id}/regeocode")
async def regeocode_route(route_id: str):
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


@router.get("/routes/{route_id}/report")
async def route_report(route_id: str, courier: str = Query("", description="Imię i nazwisko kuriera")):
    """Generate the end-of-day PDF report for a route.

    Includes signatures and photos (base64 from stops) plus COD summary. Returned
    as `application/pdf` binary — frontend can download or share it.
    """
    route = await db.routes.find_one({"id": route_id}, {"_id": 0})
    if not route:
        raise HTTPException(status_code=404, detail="Trasa nie znaleziona")
    pdf_bytes = build_route_pdf(route, courier_name=courier)
    filename = f"raport-{route_id[:8]}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/routes/{route_id}/stops/{stop_id}")
async def get_stop(route_id: str, stop_id: str):
    route = await db.routes.find_one({"id": route_id}, {"_id": 0})
    if not route:
        raise HTTPException(status_code=404)
    for s in route.get("stops", []):
        if s["id"] == stop_id:
            return s
    raise HTTPException(status_code=404, detail="Stop nie znaleziony")


@router.post("/routes/{route_id}/stops/{stop_id}/deliver")
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


@router.post("/routes/{route_id}/stops/{stop_id}/absent")
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


@router.post("/routes/{route_id}/stops/{stop_id}/reset")
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
