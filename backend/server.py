from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import base64
import json
import logging
import uuid
import tempfile
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
from datetime import datetime, timezone

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
- "lat": szerokość geograficzna adresu jako float (WGS84). Najlepsze przybliżenie z Twojej wiedzy o polskiej geografii. Np. 53.4285 dla Szczecina.
- "lng": długość geograficzna adresu jako float. Np. 14.5528 dla Szczecina.

KRYTYCZNE ZASADY:
1. ZACHOWAJ DOKŁADNĄ KOLEJNOŚĆ Z MANIFESTU — platforma źródłowa już zoptymalizowała trasę, NIE sortuj ponownie.
2. WYDOBĄDŹ WSZYSTKIE STOPY — nagłówek mówi ile ich jest ("Stops: 104"). Nie pomijaj żadnego.
3. Polskie znaki (ł, ś, ż, ć, ń, ó, ą, ę) bywają popsute w PDF — odtwórz je tam gdzie się da (np. "Wi niewski" → "Wiśniewski", "Dor czenie" → "Doręczenie", "Grayna" → "Grażyna", "ZAK AD" → "ZAKŁAD").
4. Współrzędne lat/lng podaj zawsze — jeśli nie znasz dokładnego budynku, podaj koordynaty środka ulicy lub dzielnicy. Jeśli adres jest niejasny, podaj koordynaty centrum miasta.
5. Zwróć WYŁĄCZNIE poprawny JSON. Żadnego komentarza, żadnego markdown.

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
      "cod_amount": 0,
      "lat": 53.4285,
      "lng": 14.5528
    }
  ]
}
"""


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
    if not EMERGENT_LLM_KEY:
        raise HTTPException(status_code=500, detail="LLM key nieskonfigurowany")
    try:
        pdf_bytes = base64.b64decode(req.pdf_base64)
    except Exception:
        raise HTTPException(status_code=400, detail="Nieprawidłowy PDF (base64)")

    if len(pdf_bytes) < 100:
        raise HTTPException(status_code=400, detail="Plik PDF jest zbyt mały")

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
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

    stops: List[Stop] = []
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
        lat_val: Optional[float] = None
        lng_val: Optional[float] = None
        try:
            if s.get("lat") is not None:
                lat_val = float(s.get("lat"))
            if s.get("lng") is not None:
                lng_val = float(s.get("lng"))
        except Exception:
            lat_val = None
            lng_val = None
        stops.append(Stop(
            order=order_val,
            address=str(s.get("address", "")).strip(),
            recipient_name=str(s.get("recipient_name", "")).strip(),
            phone=str(s.get("phone", "")).strip(),
            package_numbers=[str(x) for x in (s.get("package_numbers") or [])],
            cod_amount=cod,
            is_cod=is_cod_flag,
            lat=lat_val,
            lng=lng_val,
        ))

    name = (req.name or "").strip() or f"Trasa {datetime.now(timezone.utc).strftime('%d.%m.%Y %H:%M')}"
    route = Route(name=name, stops=stops)
    await db.routes.insert_one(route.model_dump())
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
