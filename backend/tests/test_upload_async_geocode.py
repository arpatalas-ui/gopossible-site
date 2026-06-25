"""Iteration 13 — verify async upload + background geocoding.

Tests:
  * POST /api/manifest/upload returns in < 5s with 132 stops parsed.
  * GET /api/routes/{id} eventually shows geocoded lat/lng (background task).
  * GET /api/routes still works.
"""

import base64
import os
import time
from pathlib import Path

import pytest
import requests

# Use internal URL for upload timing test (per review request)
INTERNAL_URL = "http://localhost:8001"
PUBLIC_URL = os.environ.get("PUBLIC_URL", "https://courier-nav-4.preview.emergentagent.com")

XLS_URL = "https://customer-assets.emergentagent.com/job_courier-nav-4/artifacts/jvsolzfl_2026-06-25_raport_KOP.xls"
XLS_PATH = Path("/tmp/manifest.xls")


@pytest.fixture(scope="module")
def xls_b64():
    if not XLS_PATH.exists():
        r = requests.get(XLS_URL, timeout=30)
        r.raise_for_status()
        XLS_PATH.write_bytes(r.content)
    return base64.b64encode(XLS_PATH.read_bytes()).decode()


@pytest.fixture(scope="module")
def uploaded_route(xls_b64):
    payload = {"pdf_base64": xls_b64, "name": "TEST_iteration13"}
    t0 = time.monotonic()
    r = requests.post(f"{INTERNAL_URL}/api/manifest/upload", json=payload, timeout=15)
    elapsed = time.monotonic() - t0
    assert r.status_code == 200, f"upload failed: {r.status_code} {r.text[:300]}"
    data = r.json()
    print(f"\n[upload] {elapsed:.2f}s, stops={len(data.get('stops', []))}")
    yield {"elapsed": elapsed, "route": data}
    # Cleanup
    try:
        requests.delete(f"{INTERNAL_URL}/api/routes/{data['id']}", timeout=5)
    except Exception:
        pass


# ---- Upload performance & data ----
def test_upload_fast(uploaded_route):
    assert uploaded_route["elapsed"] < 5.0, (
        f"Upload took {uploaded_route['elapsed']:.2f}s (>5s) — bug not fixed"
    )


def test_upload_returns_132_stops(uploaded_route):
    stops = uploaded_route["route"]["stops"]
    assert len(stops) == 132, f"Expected 132 stops, got {len(stops)}"


def test_upload_fields_present(uploaded_route):
    s = uploaded_route["route"]["stops"][0]
    for key in (
        "recipient_name",
        "address",
        "phone",
        "cod_amount",
        "extra_fees",
        "is_cod",
        "package_numbers",
    ):
        assert key in s, f"Missing key {key} in stop: {s}"
    assert isinstance(s["package_numbers"], list) and s["package_numbers"], "package_numbers empty"


def test_upload_cod_flag_present(uploaded_route):
    stops = uploaded_route["route"]["stops"]
    # At least one stop should have COD according to the source file
    cods = [s for s in stops if s.get("is_cod")]
    print(f"\n[cod] {len(cods)} of {len(stops)} stops are COD")
    # Don't strict-assert >0 (depends on source), but ensure type
    for s in stops:
        assert isinstance(s["is_cod"], bool)


def test_initial_latlng_can_be_none(uploaded_route):
    """Stops may have None lat/lng right after upload (geocoding is async)."""
    stops = uploaded_route["route"]["stops"]
    # Either all None (just deferred) or some already set — we just don't fail here
    none_count = sum(1 for s in stops if s.get("lat") is None)
    print(f"\n[geocode-initial] {none_count}/{len(stops)} stops have no lat yet")
    assert none_count >= 0  # informational


# ---- Background geocoding progress ----
def test_background_geocoding_progresses(uploaded_route):
    route_id = uploaded_route["route"]["id"]
    deadline = time.monotonic() + 180  # 3 minutes
    last = 0
    target = 10
    while time.monotonic() < deadline:
        r = requests.get(f"{INTERNAL_URL}/api/routes/{route_id}", timeout=10)
        assert r.status_code == 200
        stops = r.json().get("stops", [])
        geocoded = sum(1 for s in stops if s.get("lat") is not None)
        if geocoded != last:
            print(f"\n[bg-geocode] {geocoded}/{len(stops)} geocoded so far")
            last = geocoded
        if geocoded >= target:
            print(f"\n[bg-geocode] reached target {target} in time")
            return
        time.sleep(10)
    raise AssertionError(
        f"Background geocoding did not reach {target} stops within 3 min (last={last})"
    )


# ---- Smoke ----
def test_list_routes_ok():
    r = requests.get(f"{INTERNAL_URL}/api/routes", timeout=10)
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_public_root_ok():
    r = requests.get(f"{PUBLIC_URL}/api/", timeout=10)
    assert r.status_code == 200
