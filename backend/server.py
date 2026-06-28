"""FastAPI app entry point. Thin: just middleware + router registration."""
import logging
from fastapi import FastAPI, APIRouter
from starlette.middleware.cors import CORSMiddleware

from app_core.db import client
from app_core.routers import routes as routes_router
from app_core.routers import transfer as transfer_router
from app_core.routers import locations as locations_router

app = FastAPI()
api_router = APIRouter(prefix="/api")
api_router.include_router(routes_router.router)
api_router.include_router(transfer_router.router)
api_router.include_router(locations_router.router)
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
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
)
logger = logging.getLogger(__name__)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
