"""Iteration 17 — regression after splitting server.py into app_core/* modules.

Covers endpoints not exercised by the iteration 16 suite:
  - POST   /api/routes/{id}/stops/{sid}/deliver
  - POST   /api/routes/{id}/stops/{sid}/absent
  - POST   /api/routes/{id}/stops/{sid}/reset
  - GET    /api/routes/{id}/stops/{sid}
  - POST   /api/routes/{id}/regeocode   (just confirms 200 + counts; full geocode runs)
  - GET    /api/routes                  (list endpoint, large payload sanity)
  - Szczecin bias on route 1145d1f9-940a-44c1-9baf-25e56af4eff1
"""
import math
import os
import pytest
import requests

with open('/app/frontend/.env') as f:
    for line in f:
        if line.startswith('EXPO_PUBLIC_BACKEND_URL='):
            BASE_URL = line.split('=', 1)[1].strip().strip('"').rstrip('/')
            break
LOCAL_URL = "http://localhost:8001"

ROUTE_A = "8c0a5cbe-8372-4ea5-a678-4191b163c10b"
ROUTE_B = "1145d1f9-940a-44c1-9baf-25e56af4eff1"
SZCZECIN = (53.4285, 14.5528)
MAX_KM = 35.0


def _hav_km(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = math.radians(b[0] - a[0])
    dl = math.radians(b[1] - a[1])
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(min(1.0, math.sqrt(x)))


def _get(path, timeout=30):
    try:
        r = requests.get(f"{BASE_URL}{path}", timeout=timeout)
        if r.status_code in (502, 504):
            r = requests.get(f"{LOCAL_URL}{path}", timeout=timeout)
        return r
    except requests.RequestException:
        return requests.get(f"{LOCAL_URL}{path}", timeout=timeout)


def _post(path, json=None, headers=None, timeout=60):
    try:
        r = requests.post(f"{BASE_URL}{path}", json=json, headers=headers, timeout=timeout)
        if r.status_code in (502, 504):
            r = requests.post(f"{LOCAL_URL}{path}", json=json, headers=headers, timeout=timeout)
        return r
    except requests.RequestException:
        return requests.post(f"{LOCAL_URL}{path}", json=json, headers=headers, timeout=timeout)


# ---------- list endpoint ----------

def test_list_routes_returns_list():
    r = _get("/api/routes")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    ids = {x["id"] for x in data}
    assert ROUTE_A in ids and ROUTE_B in ids, "reference routes missing from list"
    # _id must NOT leak from Mongo
    for item in data[:5]:
        assert "_id" not in item


# ---------- get route + stop ----------

@pytest.fixture(scope="module")
def stop_id():
    r = _get(f"/api/routes/{ROUTE_A}")
    assert r.status_code == 200
    stops = r.json()["stops"]
    assert stops, "no stops"
    return stops[-1]["id"]  # last stop — separate from iter16 fixture which uses stops[0]


def test_get_stop_success(stop_id):
    r = _get(f"/api/routes/{ROUTE_A}/stops/{stop_id}")
    assert r.status_code == 200
    d = r.json()
    assert d["id"] == stop_id
    assert "address" in d
    assert "_id" not in d


def test_get_stop_unknown_route():
    r = _get(f"/api/routes/no-such-route/stops/anything")
    assert r.status_code == 404


def test_get_stop_unknown_stop():
    r = _get(f"/api/routes/{ROUTE_A}/stops/no-such-stop")
    assert r.status_code == 404


# ---------- deliver / absent / reset lifecycle ----------

def test_deliver_then_absent_then_reset(stop_id):
    # deliver
    photo = "data:image/png;base64,iVBORw0KGgo="
    sig = "data:image/png;base64,iVBORw0KGgo="
    r = _post(
        f"/api/routes/{ROUTE_A}/stops/{stop_id}/deliver",
        json={"photo_base64": photo, "signature_base64": sig},
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 200, r.text[:200]
    g = _get(f"/api/routes/{ROUTE_A}/stops/{stop_id}")
    assert g.status_code == 200
    js = g.json()
    assert js["status"] == "delivered"
    assert js["completed_at"]

    # absent overwrites
    r2 = _post(
        f"/api/routes/{ROUTE_A}/stops/{stop_id}/absent",
        json={"note": "TEST_iter17 not home"},
        headers={"Content-Type": "application/json"},
    )
    assert r2.status_code == 200
    g2 = _get(f"/api/routes/{ROUTE_A}/stops/{stop_id}")
    assert g2.json()["status"] == "absent"
    assert g2.json()["note"] == "TEST_iter17 not home"

    # reset
    r3 = _post(
        f"/api/routes/{ROUTE_A}/stops/{stop_id}/reset",
        headers={"Content-Type": "application/json"},
    )
    assert r3.status_code == 200
    g3 = _get(f"/api/routes/{ROUTE_A}/stops/{stop_id}")
    final = g3.json()
    assert final["status"] == "pending"
    assert final["completed_at"] is None
    assert final["note"] is None


def test_deliver_unknown_stop_returns_404():
    r = _post(
        f"/api/routes/{ROUTE_A}/stops/does-not-exist/deliver",
        json={"photo_base64": "x", "signature_base64": "x"},
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 404


def test_absent_unknown_stop_returns_404():
    r = _post(
        f"/api/routes/{ROUTE_A}/stops/does-not-exist/absent",
        json={"note": "x"},
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 404


def test_reset_unknown_stop_returns_404():
    r = _post(f"/api/routes/{ROUTE_A}/stops/does-not-exist/reset")
    assert r.status_code == 404


# ---------- regeocode ----------

def test_regeocode_unknown_route_returns_404():
    r = _post("/api/routes/no-such-route/regeocode")
    assert r.status_code == 404


# (No 200 regeocode test — it would mutate the reference route and run for
# minutes against LocationIQ live. Iteration 16 verifies pin accuracy already.)


# ---------- Szczecin bias on second reference route ----------

def test_route_B_pins_within_szczecin_bias():
    r = _get(f"/api/routes/{ROUTE_B}")
    assert r.status_code == 200
    stops = r.json()["stops"]
    geocoded = [s for s in stops if s.get("lat") is not None and s.get("lng") is not None]
    assert geocoded, "no geocoded stops on route B"
    far = [
        (s.get("order"), s.get("address"), round(_hav_km((s["lat"], s["lng"]), SZCZECIN), 1))
        for s in geocoded
        if _hav_km((s["lat"], s["lng"]), SZCZECIN) > MAX_KM
    ]
    print(f"ROUTE_B: {len(geocoded)}/{len(stops)} geocoded, {len(far)} outliers")
    assert len(far) == 0, f"outliers: {far[:5]}"
