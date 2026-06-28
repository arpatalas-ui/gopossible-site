"""Iteration 19 — GPS courier location tracking endpoints.

Tests:
- POST /api/courier/locations  (public, validates lat/lng required)
- GET  /api/courier/locations  (X-Api-Key auth, aggregated latest per courier)
- GET  /api/courier/locations?courier_id=...  (history for single courier)
- TTL index sanity check on `courier_locations.created_at_dt`
"""
import os
import time
import uuid
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv

# Load backend .env so we can read GOPOSSIBLE_API_KEY + MONGO_URL for the TTL check.
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL") or os.environ.get("EXPO_BACKEND_URL")
if not BASE_URL:
    # Fallback to the public preview URL used by the frontend.
    BASE_URL = "https://courier-nav-4.preview.emergentagent.com"
BASE_URL = BASE_URL.rstrip("/")

API_KEY = os.environ["GOPOSSIBLE_API_KEY"]
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]

LOC_URL = f"{BASE_URL}/api/courier/locations"


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def test_run_id():
    # Unique tag so we can isolate this run from any prior data.
    return f"TEST_{uuid.uuid4().hex[:8]}"


# ---------------------------- POST endpoint ----------------------------

class TestPostLocation:
    def test_post_full_ping_returns_ok_and_ts(self, session, test_run_id):
        payload = {
            "courier_id": f"{test_run_id}-K-001",
            "courier_name": "Jan Kowalski",
            "lat": 53.4285,
            "lng": 14.5528,
            "accuracy": 12.0,
            "speed": 8.5,
            "heading": 90.0,
            "altitude": 50.0,
            "route_id": "route-xyz",
            "client_ts": "2026-06-28T14:38:20Z",
        }
        r = session.post(LOC_URL, json=payload)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("ok") is True
        assert isinstance(body.get("ts"), str) and len(body["ts"]) >= 19  # ISO timestamp

    def test_post_minimal_ping_lat_lng_only(self, session, test_run_id):
        payload = {"lat": 52.2297, "lng": 21.0122}
        r = session.post(LOC_URL, json=payload)
        assert r.status_code == 200, r.text
        assert r.json().get("ok") is True

    def test_post_missing_lat_returns_422(self, session):
        r = session.post(LOC_URL, json={"lng": 21.0})
        assert r.status_code == 422

    def test_post_missing_lng_returns_422(self, session):
        r = session.post(LOC_URL, json={"lat": 52.2})
        assert r.status_code == 422

    def test_post_invalid_type_lat_string_returns_422(self, session):
        r = session.post(LOC_URL, json={"lat": "abc", "lng": 21.0})
        assert r.status_code == 422

    def test_post_invalid_type_lng_string_returns_422(self, session):
        r = session.post(LOC_URL, json={"lat": 52.0, "lng": "xyz"})
        assert r.status_code == 422


# ---------------------------- GET endpoint auth ----------------------------

class TestGetLocationAuth:
    def test_get_without_api_key_returns_401(self, session):
        r = session.get(LOC_URL)
        assert r.status_code == 401

    def test_get_with_wrong_api_key_returns_401(self, session):
        r = session.get(LOC_URL, headers={"X-Api-Key": "wrong-key-xxx"})
        assert r.status_code == 401

    def test_get_with_empty_api_key_returns_401(self, session):
        # 'requests' library rejects whitespace-only headers; use a dummy short token
        # to exercise the strip()/mismatch branch in the router.
        r = session.get(LOC_URL, headers={"X-Api-Key": "x"})
        assert r.status_code == 401

    def test_get_with_valid_key_returns_200_and_list(self, session):
        r = session.get(LOC_URL, headers={"X-Api-Key": API_KEY})
        assert r.status_code == 200, r.text
        body = r.json()
        assert "couriers" in body and isinstance(body["couriers"], list)
        assert body.get("since_minutes") == 60


# --------------------- Aggregation: latest per courier ---------------------

class TestAggregationAndHistory:
    def test_three_pings_same_courier_aggregated_returns_latest_only(self, session, test_run_id):
        cid = f"{test_run_id}-K-AGG"
        coords = [
            (53.1000, 14.5000),
            (53.2000, 14.5100),
            (53.3000, 14.5200),  # this one is LAST → must be in aggregated view
        ]
        last_ts = None
        for lat, lng in coords:
            r = session.post(LOC_URL, json={"courier_id": cid, "courier_name": "Agg Tester", "lat": lat, "lng": lng})
            assert r.status_code == 200
            last_ts = r.json()["ts"]
            time.sleep(0.05)  # ensure distinct created_at

        r = session.get(LOC_URL, headers={"X-Api-Key": API_KEY}, params={"since_minutes": 60})
        assert r.status_code == 200
        couriers = r.json()["couriers"]
        matched = [c for c in couriers if c.get("courier_id") == cid]
        assert len(matched) == 1, f"Expected exactly 1 entry for {cid}, got {len(matched)}: {matched}"
        latest = matched[0]
        assert latest["lat"] == 53.3000
        assert latest["lng"] == 14.5200
        assert latest["created_at"] == last_ts

    def test_history_endpoint_returns_all_pings_for_courier(self, session, test_run_id):
        cid = f"{test_run_id}-K-AGG"  # same as above — has 3 pings
        r = session.get(LOC_URL, headers={"X-Api-Key": API_KEY}, params={"courier_id": cid})
        assert r.status_code == 200
        body = r.json()
        assert body["courier_id"] == cid
        pings = body["pings"]
        assert len(pings) == 3, f"Expected 3 history pings, got {len(pings)}"
        # sorted desc by created_at
        ts_list = [p["created_at"] for p in pings]
        assert ts_list == sorted(ts_list, reverse=True)
        # And the latest entry corresponds to the last POST (lat=53.3)
        assert pings[0]["lat"] == 53.3000

    def test_two_different_couriers_aggregated_returns_two_entries(self, session, test_run_id):
        cid_a = f"{test_run_id}-K-A"
        cid_b = f"{test_run_id}-K-B"
        # 2 pings for A, 1 for B
        for lat in (50.0, 50.1):
            session.post(LOC_URL, json={"courier_id": cid_a, "lat": lat, "lng": 19.0})
            time.sleep(0.03)
        session.post(LOC_URL, json={"courier_id": cid_b, "lat": 51.5, "lng": 17.0})

        r = session.get(LOC_URL, headers={"X-Api-Key": API_KEY}, params={"since_minutes": 60})
        assert r.status_code == 200
        couriers = r.json()["couriers"]
        ids_in_resp = {c.get("courier_id") for c in couriers}
        assert cid_a in ids_in_resp
        assert cid_b in ids_in_resp
        # ensure latest for A is 50.1
        a_entry = next(c for c in couriers if c.get("courier_id") == cid_a)
        assert a_entry["lat"] == 50.1

    def test_since_minutes_1_includes_fresh_ping(self, session, test_run_id):
        cid = f"{test_run_id}-K-FRESH"
        r = session.post(LOC_URL, json={"courier_id": cid, "lat": 54.0, "lng": 18.0})
        assert r.status_code == 200

        r = session.get(LOC_URL, headers={"X-Api-Key": API_KEY}, params={"since_minutes": 1})
        assert r.status_code == 200
        body = r.json()
        assert body["since_minutes"] == 1
        ids_in_resp = {c.get("courier_id") for c in body["couriers"]}
        assert cid in ids_in_resp, "Freshly-inserted ping should be in since_minutes=1 window"

    def test_since_minutes_out_of_range_rejected(self, session):
        r = session.get(LOC_URL, headers={"X-Api-Key": API_KEY}, params={"since_minutes": 0})
        assert r.status_code == 422
        r = session.get(LOC_URL, headers={"X-Api-Key": API_KEY}, params={"since_minutes": 1441})
        assert r.status_code == 422

    def test_response_excludes_mongo_internals(self, session, test_run_id):
        # _id and created_at_dt must NOT leak in either view
        r = session.get(LOC_URL, headers={"X-Api-Key": API_KEY})
        assert r.status_code == 200
        for c in r.json()["couriers"]:
            assert "_id" not in c
            assert "created_at_dt" not in c

        cid = f"{test_run_id}-K-AGG"
        r = session.get(LOC_URL, headers={"X-Api-Key": API_KEY}, params={"courier_id": cid})
        assert r.status_code == 200
        for p in r.json()["pings"]:
            assert "_id" not in p
            assert "created_at_dt" not in p


# ----------------------------- TTL Index Check -----------------------------

class TestTTLIndex:
    def test_ttl_index_exists_with_24h_expiry(self):
        """Verify Mongo has a TTL index on created_at_dt with expireAfterSeconds=86400.

        We hit POST once first to make sure `_ensure_indexes` has been triggered.
        """
        # Ensure POST has run so indexes are created.
        requests.post(LOC_URL, json={"lat": 0.0, "lng": 0.0})

        from pymongo import MongoClient
        cli = MongoClient(MONGO_URL)
        try:
            indexes = list(cli[DB_NAME].courier_locations.list_indexes())
        finally:
            cli.close()

        ttl_idx = None
        for idx in indexes:
            if idx.get("expireAfterSeconds") is not None:
                ttl_idx = idx
                break

        assert ttl_idx is not None, f"No TTL index found. Indexes: {indexes}"
        # Key must be on created_at_dt
        keys = list(ttl_idx.get("key", {}).keys())
        assert "created_at_dt" in keys, f"TTL index not on created_at_dt: {ttl_idx}"
        assert ttl_idx["expireAfterSeconds"] == 86400, f"Expected 86400s, got {ttl_idx['expireAfterSeconds']}"


# ------------------------------ Cleanup ------------------------------

@pytest.fixture(scope="module", autouse=True)
def _cleanup_after_module(test_run_id):
    """Delete TEST_ prefixed pings after the module is done."""
    yield
    try:
        from pymongo import MongoClient
        cli = MongoClient(MONGO_URL)
        cli[DB_NAME].courier_locations.delete_many({"courier_id": {"$regex": f"^{test_run_id}"}})
        # Also clean the lat=0,lng=0 ping inserted by TTL test and the minimal ping with empty courier_id
        # Only delete pings with empty courier_id and lat=0, lng=0 to avoid touching anything else
        cli[DB_NAME].courier_locations.delete_many({"courier_id": "", "lat": 0.0, "lng": 0.0})
        cli[DB_NAME].courier_locations.delete_many({"courier_id": "", "lat": 52.2297, "lng": 21.0122})
        cli[DB_NAME].courier_locations.delete_many({"courier_id": "", "courier_name": "Jan Kowalski"})
        cli.close()
    except Exception as e:
        print(f"Cleanup warning: {e}")
