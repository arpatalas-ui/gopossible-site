"""Iteration 16 — backend tests for new endpoints:
  - /api/transfer/create  (X-Api-Key auth)
  - /api/transfer/{code}
  - /api/transfer/{code}/status
  - /api/routes/{id}/approve  +  /unapprove
  - /api/routes/{id}/stops/{stop_id}/address  (PATCH-style re-geocode)
  - Szczecin geocode bias verification (all pins within 35 km of city centre)
"""
import base64
import math
import os
import time
import pytest
import requests

# Public URL is preferred; fall back to localhost backend if ingress times out
# on large uploads.
with open('/app/frontend/.env') as f:
    for line in f:
        if line.startswith('EXPO_PUBLIC_BACKEND_URL='):
            BASE_URL = line.split('=', 1)[1].strip().strip('"').rstrip('/')
            break
LOCAL_URL = "http://localhost:8001"

GOPOSSIBLE_API_KEY = "Um5sYY1aoX4P7vnJU6XA5D067W36wj4rNmQQyuSED5g"
XLS_URL = (
    "https://customer-assets.emergentagent.com/job_courier-nav-4/"
    "artifacts/jvsolzfl_2026-06-25_raport_KOP.xls"
)
EXISTING_ROUTE_ID = "8c0a5cbe-8372-4ea5-a678-4191b163c10b"  # 167 stops
SZCZECIN_CENTER = (53.4285, 14.5528)
SZCZECIN_MAX_KM = 35.0


def _hav_km(a, b):
    lat1, lng1 = a
    lat2, lng2 = b
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(min(1.0, math.sqrt(x)))


def _post(path, json=None, headers=None, timeout=60):
    """POST with public URL → localhost fallback on 502/504/connection error."""
    try:
        r = requests.post(f"{BASE_URL}{path}", json=json, headers=headers, timeout=timeout)
        if r.status_code in (502, 504):
            r = requests.post(f"{LOCAL_URL}{path}", json=json, headers=headers, timeout=timeout)
        return r
    except requests.RequestException:
        return requests.post(f"{LOCAL_URL}{path}", json=json, headers=headers, timeout=timeout)


def _get(path, timeout=30):
    try:
        r = requests.get(f"{BASE_URL}{path}", timeout=timeout)
        if r.status_code in (502, 504):
            r = requests.get(f"{LOCAL_URL}{path}", timeout=timeout)
        return r
    except requests.RequestException:
        return requests.get(f"{LOCAL_URL}{path}", timeout=timeout)


def _delete(path, timeout=30):
    try:
        return requests.delete(f"{BASE_URL}{path}", timeout=timeout)
    except requests.RequestException:
        return requests.delete(f"{LOCAL_URL}{path}", timeout=timeout)


# ---------- Fixtures ----------

@pytest.fixture(scope="module")
def xls_b64():
    r = requests.get(XLS_URL, timeout=60)
    assert r.status_code == 200, f"download xls: {r.status_code}"
    assert r.content[:4] == b"\xd0\xcf\x11\xe0", "not an XLS"
    return base64.b64encode(r.content).decode()


@pytest.fixture(scope="module")
def created_transfer(xls_b64):
    """Create a transfer via the authenticated endpoint, return the response.
    Auto-cleans the resulting route at the end of the module."""
    payload = {"pdf_base64": xls_b64, "name": "TEST_iter16_transfer"}
    headers = {"X-Api-Key": GOPOSSIBLE_API_KEY, "Content-Type": "application/json"}
    r = _post("/api/transfer/create", json=payload, headers=headers, timeout=240)
    assert r.status_code == 200, f"transfer/create failed: {r.status_code} {r.text[:300]}"
    data = r.json()
    yield data
    # cleanup
    try:
        _delete(f"/api/routes/{data['route_id']}")
    except Exception:
        pass


# ---------- 1) transfer/create auth ----------

def test_transfer_create_without_key_returns_401(xls_b64):
    r = _post("/api/transfer/create", json={"pdf_base64": xls_b64, "name": "x"})
    assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text[:200]}"


def test_transfer_create_wrong_key_returns_401(xls_b64):
    r = _post(
        "/api/transfer/create",
        json={"pdf_base64": xls_b64, "name": "x"},
        headers={"X-Api-Key": "wrong-key-xxx", "Content-Type": "application/json"},
    )
    assert r.status_code == 401


def test_transfer_create_empty_file_returns_400():
    tiny = base64.b64encode(b"x").decode()
    r = _post(
        "/api/transfer/create",
        json={"pdf_base64": tiny, "name": "x"},
        headers={"X-Api-Key": GOPOSSIBLE_API_KEY, "Content-Type": "application/json"},
    )
    assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text[:200]}"


def test_transfer_create_invalid_bytes_returns_400():
    junk = base64.b64encode(b"\x00" * 500).decode()
    r = _post(
        "/api/transfer/create",
        json={"pdf_base64": junk, "name": "x"},
        headers={"X-Api-Key": GOPOSSIBLE_API_KEY, "Content-Type": "application/json"},
    )
    assert r.status_code == 400


# ---------- 2) transfer/create success ----------

def test_transfer_create_success_shape(created_transfer):
    d = created_transfer
    for k in ("transfer_code", "qr_payload", "route_id", "stops", "expires_at"):
        assert k in d, f"missing key {k} in {d}"
    assert isinstance(d["transfer_code"], str) and len(d["transfer_code"]) == 6
    assert d["qr_payload"] == f"gopossible:transfer:{d['transfer_code']}"
    assert d["stops"] >= 100, f"expected many stops, got {d['stops']}"


# ---------- 3) transfer/{code} ----------

def test_transfer_fetch_unknown_returns_404():
    r = _get("/api/transfer/ZZZZZZ")
    assert r.status_code == 404


def test_transfer_fetch_returns_route_and_marks_claimed(created_transfer):
    code = created_transfer["transfer_code"]
    r = _get(f"/api/transfer/{code}")
    assert r.status_code == 200, f"{r.status_code}: {r.text[:200]}"
    d = r.json()
    assert "route" in d and "transfer" in d
    assert d["route"]["id"] == created_transfer["route_id"]
    assert len(d["route"]["stops"]) == created_transfer["stops"]
    # claimed_at must be set after first fetch
    assert d["transfer"]["claimed_at"] is not None, "claimed_at should be set on first fetch"
    assert d["transfer"]["code"] == code
    assert d["transfer"]["source"] == "gopossible.pl"


def test_transfer_fetch_is_case_insensitive(created_transfer):
    code = created_transfer["transfer_code"].lower()
    r = _get(f"/api/transfer/{code}")
    assert r.status_code == 200


# ---------- 4) transfer/{code}/status ----------

def test_transfer_status_unknown_returns_404():
    r = _get("/api/transfer/ZZZZZZ/status")
    assert r.status_code == 404


def test_transfer_status_no_auth_required(created_transfer):
    code = created_transfer["transfer_code"]
    r = _get(f"/api/transfer/{code}/status")
    assert r.status_code == 200
    d = r.json()
    assert d["route_id"] == created_transfer["route_id"]
    assert "claimed_at" in d
    assert "expires_at" in d


# ---------- 5) approve / unapprove ----------

def test_approve_unknown_route_returns_404():
    r = _post("/api/routes/does-not-exist-xxx/approve")
    assert r.status_code == 404


def test_approve_sets_approved_at():
    r = _post(f"/api/routes/{EXISTING_ROUTE_ID}/approve")
    assert r.status_code == 200, r.text[:200]
    d = r.json()
    assert d["ok"] is True
    assert d["approved_at"]
    # verify persisted
    g = _get(f"/api/routes/{EXISTING_ROUTE_ID}")
    assert g.status_code == 200
    assert g.json().get("approved_at") == d["approved_at"]


def test_approve_is_idempotent():
    r1 = _post(f"/api/routes/{EXISTING_ROUTE_ID}/approve")
    assert r1.status_code == 200
    ts1 = r1.json()["approved_at"]
    time.sleep(1.1)
    r2 = _post(f"/api/routes/{EXISTING_ROUTE_ID}/approve")
    assert r2.status_code == 200
    ts2 = r2.json()["approved_at"]
    assert ts2 > ts1, "second approve must refresh the timestamp"


def test_unapprove_clears_approved_at():
    # ensure approved first
    _post(f"/api/routes/{EXISTING_ROUTE_ID}/approve")
    r = _post(f"/api/routes/{EXISTING_ROUTE_ID}/unapprove")
    assert r.status_code == 200
    g = _get(f"/api/routes/{EXISTING_ROUTE_ID}")
    assert g.status_code == 200
    assert g.json().get("approved_at") is None


def test_unapprove_unknown_route_returns_404():
    r = _post("/api/routes/does-not-exist-xxx/unapprove")
    assert r.status_code == 404


# ---------- 6) stop address update + re-geocode ----------

@pytest.fixture(scope="module")
def sample_stop_id():
    r = _get(f"/api/routes/{EXISTING_ROUTE_ID}")
    assert r.status_code == 200
    stops = r.json()["stops"]
    assert stops, "route has no stops"
    return stops[0]["id"]


def test_update_address_empty_returns_400(sample_stop_id):
    r = _post(
        f"/api/routes/{EXISTING_ROUTE_ID}/stops/{sample_stop_id}/address",
        json={"address": "   "},
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 400


def test_update_address_unknown_stop_returns_404():
    r = _post(
        f"/api/routes/{EXISTING_ROUTE_ID}/stops/does-not-exist/address",
        json={"address": "Wojska Polskiego 1, Szczecin"},
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 404


def test_update_address_szczecin_geocodes_within_bias(sample_stop_id):
    """Setting an address in Szczecin must return geocoded=true and a lat/lng
    within 35 km of the Szczecin centre."""
    new_addr = "Wojska Polskiego 64, Szczecin"
    r = _post(
        f"/api/routes/{EXISTING_ROUTE_ID}/stops/{sample_stop_id}/address",
        json={"address": new_addr},
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 200, r.text[:200]
    d = r.json()
    assert d["ok"] is True
    assert d["address"] == new_addr
    assert d["geocoded"] is True, f"expected geocoded=True, got {d}"
    assert d["lat"] is not None and d["lng"] is not None
    dist = _hav_km((d["lat"], d["lng"]), SZCZECIN_CENTER)
    assert dist <= SZCZECIN_MAX_KM, f"Geocoded point {dist:.1f} km from Szczecin centre"

    # verify persistence by fetching the stop
    g = _get(f"/api/routes/{EXISTING_ROUTE_ID}/stops/{sample_stop_id}")
    assert g.status_code == 200
    js = g.json()
    assert js["address"] == new_addr
    assert js["lat"] is not None and js["lng"] is not None


def test_update_address_gibberish_returns_geocoded_false(sample_stop_id):
    """Unrecognisable address must save the text but set lat/lng to null."""
    gib = "qzx zzz qqq xyzxyz 9999, Atlantydaaa"
    r = _post(
        f"/api/routes/{EXISTING_ROUTE_ID}/stops/{sample_stop_id}/address",
        json={"address": gib},
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 200, r.text[:200]
    d = r.json()
    assert d["ok"] is True
    assert d["address"] == gib
    assert d["geocoded"] is False, f"expected geocoded=False, got {d}"
    assert d["lat"] is None and d["lng"] is None


# ---------- 7) Szczecin bias verification on the entire existing route ----------

def test_existing_route_pins_all_within_szczecin_bias():
    """Every stop with coords on the 167-stop sample route must be ≤ 35 km
    from the Szczecin centre (the city-prior bias must keep all pins local)."""
    r = _get(f"/api/routes/{EXISTING_ROUTE_ID}")
    assert r.status_code == 200
    stops = r.json()["stops"]
    geocoded = [s for s in stops if s.get("lat") is not None and s.get("lng") is not None]
    assert geocoded, "route has no geocoded stops yet"
    far = []
    for s in geocoded:
        d = _hav_km((s["lat"], s["lng"]), SZCZECIN_CENTER)
        if d > SZCZECIN_MAX_KM:
            far.append((s.get("order"), s.get("address"), round(d, 1)))
    print(f"Geocoded {len(geocoded)}/{len(stops)} stops; {len(far)} outside 35 km")
    if far:
        print("Outliers:", far[:10])
    assert len(far) == 0, f"{len(far)} pins outside 35 km of Szczecin centre: {far[:5]}"
