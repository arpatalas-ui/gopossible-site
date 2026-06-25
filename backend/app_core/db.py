"""Mongo client + DB handle. Loaded once at process start."""
import os
from pathlib import Path
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv(Path(__file__).resolve().parent.parent / '.env')

_mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(_mongo_url)
db = client[os.environ['DB_NAME']]

EMERGENT_LLM_KEY = os.environ.get('EMERGENT_LLM_KEY')
LOCATIONIQ_KEY = os.environ.get('LOCATIONIQ_KEY')
GOPOSSIBLE_API_KEY = os.environ.get('GOPOSSIBLE_API_KEY')
