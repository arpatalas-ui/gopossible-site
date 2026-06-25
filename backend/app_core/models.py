"""Pydantic models shared across routers."""
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from pydantic import BaseModel, Field


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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
