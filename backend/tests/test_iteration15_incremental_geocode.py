"""Iteration 15 tests for the incremental background geocoder fixes.

Verifies:
1. `_nominatim_paced` enforces ≥1.0 s between calls (rate-limit lock).
2. `_background_geocode_route` writes EACH success via per-stop $set
   (per-stop update_one with positional $) — confirmed by source inspection.
3. POST /api/manifest/upload returns < 5 s and triggers background geocoding
   that progressively writes lat/lng to MongoDB.
"""
import asyncio
import base64
import os
import sys
import time
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8001').rstrip('/')
LOCAL_URL = "http://localhost:8001"
XLS_URL = "https://customer-assets.emergentagent.com/job_courier-nav-4/artifacts/jvsolzfl_2026-06-25_raport_KOP.xls"


@pytest.fixture(scope="module")
def xls_b64():
    r = requests.get(XLS_URL, timeout=60)
    r.raise_for_status()
    return base64.b64encode(r.content).decode()


@pytest.fixture
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# -------- 1. Source-code shape check (per-stop update inside loop) --------

def test_background_geocoder_does_per_stop_update():
    src = Path("/app/backend/server.py").read_text()
    # The fixed code must include a per-stop update_one inside _background_geocode_route
    fn_start = src.find("async def _background_geocode_route")
    assert fn_start > 0, "_background_geocode_route not found"
    fn_end = src.find("\n\n", fn_start + 100)
    body = src[fn_start:fn_end]
    assert "update_one" in body, "Background geocoder must call update_one per stop"
    assert "stops.$.lat" in body and "stops.$.lng" in body, \
        "Background geocoder must use positional $ to update individual stop lat/lng"
    # Must NOT do single batch write at the very end (legacy pattern)
    assert "$set\": {\"stops\":" not in body, "Old batch write detected — must be per-stop"


# -------- 2. Nominatim pacing (lock + monotonic) --------

def test_nominatim_paced_lock_enforces_min_interval():
    from server import _nominatim_paced  # noqa: E402

    async def runner():
        # First call burns the monotonic baseline; second must wait ≥1.0 s.
        t0 = time.monotonic()
        await _nominatim_paced("Plac Defilad 1, Warszawa")
        t1 = time.monotonic()
        await _nominatim_paced("Rynek Główny 1, Kraków")
        t2 = time.monotonic()
        return t1 - t0, t2 - t1

    first, second = asyncio.run(runner())
    # The first call has no prior timestamp, so it should be near-instant (network only).
    # The second call must be paced ≥1.0 s after the first finished.
    assert second >= 1.0, f"Second Nominatim call was {second:.2f}s after first — pacing not enforced"


# -------- 3. End-to-end progressive write check --------

def test_manifest_upload_fast_and_progressive_geocode(api_client, xls_b64):
    payload = {"pdf_base64": xls_b64, "name": "TEST_iter15_incremental"}
    t0 = time.monotonic()
    r = api_client.post(f"{LOCAL_URL}/api/manifest/upload", json=payload, timeout=15)
    elapsed = time.monotonic() - t0
    assert r.status_code == 200, f"Upload failed: {r.status_code} {r.text[:300]}"
    assert elapsed < 5.0, f"Upload took {elapsed:.2f}s — must be <5s (background geocode)"
    route = r.json()
    route_id = route["id"]

    try:
        n_stops = len(route["stops"])
        assert n_stops > 0
        # Snapshot the count of geocoded stops at t=0, then poll for up to 3 minutes.
        def count_geo(rt):
            return sum(1 for s in rt["stops"] if s.get("lat") is not None and s.get("lng") is not None)

        initial = count_geo(route)
        snapshots = [initial]
        deadline = time.time() + 180
        last_count = initial
        polls = 0
        while time.time() < deadline:
            time.sleep(10)
            polls += 1
            poll = api_client.get(f"{LOCAL_URL}/api/routes/{route_id}", timeout=15).json()
            c = count_geo(poll)
            snapshots.append(c)
            # Pass-criterion: we observe an INCREASE between any two polls.
            if c > last_count:
                last_count = c
                print(f"  poll #{polls}: geocoded={c}/{n_stops}  (progress observed ✓)")
                # As soon as we observe progress, the fix is verified.
                if c >= initial + 2:
                    break
            else:
                print(f"  poll #{polls}: geocoded={c}/{n_stops}")

        print(f"Snapshots: {snapshots}")
        # Pass if any monotonic increase was observed (progress visible).
        assert max(snapshots) > initial, (
            f"No new geocodes appeared in {polls} polls — incremental writes not visible. "
            f"Snapshots: {snapshots}. This could be Nominatim rate-limiting from this IP."
        )
    finally:
        api_client.delete(f"{LOCAL_URL}/api/routes/{route_id}", timeout=10)


# -------- 4. Frontend placeholder text check (source inspection) --------

def test_frontend_placeholder_text_updated():
    nav = Path("/app/frontend/app/route/[id]/stop/[stopId]/navigate.tsx").read_text()
    # Old copy must be gone
    assert "Wgraj manifest ponownie" not in nav, "OLD placeholder text still present"
    # New copy must exist
    assert "Rozpoznawanie adresu" in nav, "New placeholder text missing"
    # Polling logic exists
    assert "setTimeout" in nav and "fetchOnce" in nav, "Polling loop missing"
    assert "8000" in nav, "Expected 8 s polling interval"
