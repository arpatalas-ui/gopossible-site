"""gopossible.pl QR-transfer endpoints."""
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Header

from ..db import db, GOPOSSIBLE_API_KEY
from ..models import ManifestUploadRequest, utc_now_iso
from ..parser import parse_manifest_to_route
from ..geocoder import background_geocode_route
from .routes import _spawn_background

router = APIRouter()

TRANSFER_EXPIRY_HOURS = 24
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _gen_transfer_code() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(6))


def _require_api_key(x_api_key: Optional[str]) -> None:
    if not GOPOSSIBLE_API_KEY:
        raise HTTPException(status_code=500, detail="Integracja niedostępna — brak GOPOSSIBLE_API_KEY")
    if not x_api_key or x_api_key.strip() != GOPOSSIBLE_API_KEY:
        raise HTTPException(status_code=401, detail="Nieautoryzowany — niepoprawny X-Api-Key")


@router.post("/transfer/create")
async def transfer_create(
    req: ManifestUploadRequest,
    x_api_key: Optional[str] = Header(default=None, alias="X-Api-Key"),
):
    _require_api_key(x_api_key)
    route = await parse_manifest_to_route(req.pdf_base64, req.name)
    await db.routes.insert_one(route.model_dump())
    _spawn_background(background_geocode_route(route.id))

    code = _gen_transfer_code()
    for _ in range(5):
        if not await db.transfers.find_one({"_id": code}):
            break
        code = _gen_transfer_code()

    expires_iso = (datetime.now(timezone.utc) + timedelta(hours=TRANSFER_EXPIRY_HOURS)).isoformat()
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


@router.get("/transfer/{code}")
async def transfer_fetch(code: str):
    code_norm = (code or "").strip().upper()
    if not code_norm:
        raise HTTPException(status_code=400, detail="Brak kodu transferu")

    transfer = await db.transfers.find_one({"_id": code_norm})
    if not transfer:
        raise HTTPException(status_code=404, detail="Kod nie istnieje lub wygasł")

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

    if not transfer.get("claimed_at"):
        await db.transfers.update_one({"_id": code_norm}, {"$set": {"claimed_at": utc_now_iso()}})

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


@router.get("/transfer/{code}/status")
async def transfer_status(code: str):
    code_norm = (code or "").strip().upper()
    transfer = await db.transfers.find_one({"_id": code_norm}, {"_id": 0})
    if not transfer:
        raise HTTPException(status_code=404, detail="Brak kodu")
    return transfer
