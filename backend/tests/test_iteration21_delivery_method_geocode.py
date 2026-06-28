"""Iteration 21 — delivery_method save + /api/geocode endpoint + PDF regression."""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://courier-nav-4.preview.emergentagent.com").rstrip("/")
EXISTING_ROUTE_ID = "8c0a5cbe-8372-4ea5-a678-4191b163c10b"


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def route(api):
    r = api.get(f"{BASE_URL}/api/routes/{EXISTING_ROUTE_ID}", timeout=30)
    assert r.status_code == 200, f"route fetch failed: {r.status_code} {r.text[:200]}"
    return r.json()


# ---------- /api/geocode ----------
class TestGeocodeEndpoint:
    def test_geocode_valid_szczecin_address(self, api):
        r = api.post(f"{BASE_URL}/api/geocode", json={"address": "Wojska Polskiego 81, Szczecin"}, timeout=30)
        assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"
        body = r.json()
        assert set(body.keys()) >= {"address", "lat", "lng"}
        assert isinstance(body["lat"], (int, float))
        assert isinstance(body["lng"], (int, float))
        # Szczecin is ~ 53.43N, 14.55E
        assert 53.0 <= body["lat"] <= 54.0, f"lat out of Szczecin range: {body['lat']}"
        assert 14.0 <= body["lng"] <= 15.0, f"lng out of Szczecin range: {body['lng']}"
        assert body["address"] == "Wojska Polskiego 81, Szczecin"

    def test_geocode_empty_body_returns_400(self, api):
        r = api.post(f"{BASE_URL}/api/geocode", json={}, timeout=15)
        assert r.status_code == 400, f"expected 400 got {r.status_code} {r.text[:200]}"
        assert "pust" in r.json().get("detail", "").lower()

    def test_geocode_empty_string_returns_400(self, api):
        r = api.post(f"{BASE_URL}/api/geocode", json={"address": "   "}, timeout=15)
        assert r.status_code == 400

    def test_geocode_garbage_returns_404(self, api):
        garbage = "qzxqzxqzxxxxxqzxqzxqzxqzx-no-such-place-xxxxx"
        r = api.post(f"{BASE_URL}/api/geocode", json={"address": garbage}, timeout=30)
        assert r.status_code == 404, f"expected 404 got {r.status_code} {r.text[:200]}"
        assert "nie znaleziono" in r.json().get("detail", "").lower()


# ---------- delivery_method save → GET verifies persistence ----------
@pytest.fixture(scope="module")
def pending_stops(route):
    """Return up to 4 stops we can mutate. Prefer pending; otherwise reuse."""
    pending = [s for s in route["stops"] if s["status"] == "pending"]
    others = [s for s in route["stops"] if s["status"] != "pending"]
    pool = pending + others
    assert len(pool) >= 4, f"need >=4 stops, got {len(pool)}"
    return pool[:4]


METHODS = ["mailbox", "door", "neighbor", "fence"]


@pytest.mark.parametrize("idx,method", list(enumerate(METHODS)))
def test_deliver_saves_method_then_get_verifies(api, pending_stops, idx, method):
    stop = pending_stops[idx]
    stop_id = stop["id"]
    body = {
        "photo_base64": None if method == "neighbor" else "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        "signature_base64": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" if method == "neighbor" else None,
        "delivery_method": method,
        "note": f"TEST_iter21_{method}",
    }
    r = api.post(
        f"{BASE_URL}/api/routes/{EXISTING_ROUTE_ID}/stops/{stop_id}/deliver",
        json=body,
        timeout=30,
    )
    assert r.status_code == 200, f"deliver failed: {r.status_code} {r.text[:200]}"
    assert r.json().get("ok") is True

    # Verify persisted via GET
    g = api.get(f"{BASE_URL}/api/routes/{EXISTING_ROUTE_ID}/stops/{stop_id}", timeout=30)
    assert g.status_code == 200, f"get stop failed: {g.status_code}"
    saved = g.json()
    assert saved["status"] == "delivered"
    assert saved.get("delivery_method") == method, f"expected delivery_method={method}, got {saved.get('delivery_method')}"
    assert saved.get("note") == f"TEST_iter21_{method}"


# ---------- regression: PDF report ----------
class TestPdfRegression:
    def test_route_report_returns_pdf(self, api):
        r = api.get(f"{BASE_URL}/api/routes/{EXISTING_ROUTE_ID}/report", timeout=60)
        assert r.status_code == 200, f"report status {r.status_code} {r.text[:200]}"
        assert r.content[:5] == b"%PDF-", f"not a PDF (first bytes={r.content[:8]!r})"
        assert len(r.content) > 1000
        ct = r.headers.get("content-type", "")
        assert "pdf" in ct.lower()


# ---------- regression: list routes still works ----------
class TestListRoutesRegression:
    def test_list_routes_ok(self, api):
        r = api.get(f"{BASE_URL}/api/routes", timeout=30)
        assert r.status_code == 200
        body = r.json()
        assert isinstance(body, list)
        ids = [x["id"] for x in body]
        assert EXISTING_ROUTE_ID in ids, "fixture route missing"
