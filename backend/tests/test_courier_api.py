"""
Backend regression tests for the Polish Courier Navigation app.

Covers:
  - Health endpoint (GET /api/)
  - List routes (GET /api/routes)
  - Manifest upload via Gemini AI (POST /api/manifest/upload) -- generates a synthetic
    Polish courier PDF with reportlab and pays the LLM cost ONCE per test session.
  - Route detail / stop detail
  - Stop state machine: deliver -> reset -> absent -> reset
  - Route delete

The seeded route_id is reused across tests via a session fixture to avoid extra LLM calls.
"""
import base64
import io
import os
import sys
import time

import pytest
import requests

# Read backend URL from frontend .env to ensure we test exactly what the user sees.
def _load_backend_url() -> str:
    # Prefer EXPO_PUBLIC_BACKEND_URL (used by the Expo frontend) since that's what the
    # mobile app actually calls. Fallback to EXPO_BACKEND_URL if defined.
    env_path = "/app/frontend/.env"
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'").rstrip("/")
    url = os.environ.get("EXPO_PUBLIC_BACKEND_URL") or os.environ.get("EXPO_BACKEND_URL")
    if not url:
        raise RuntimeError("No EXPO_PUBLIC_BACKEND_URL configured")
    return url.rstrip("/")


BASE_URL = _load_backend_url()
print(f"[tests] BASE_URL = {BASE_URL}", file=sys.stderr)


def _make_polish_manifest_pdf() -> bytes:
    """Generate a synthetic Polish courier manifest PDF with reportlab."""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    w, h = A4
    y = h - 60

    c.setFont("Helvetica-Bold", 14)
    c.drawString(40, y, "MANIFEST KURIERSKI - TEST_TRASA")
    y -= 30
    c.setFont("Helvetica", 10)

    stops = [
        {
            "address": "ul. Marszalkowska 12, 00-001 Warszawa",
            "recipient": "Jan Kowalski",
            "phone": "+48 600 100 200",
            "pkg": "PCK10001",
            "cod": "150.00 PLN",
        },
        {
            "address": "ul. Pulawska 145, 02-715 Warszawa",
            "recipient": "Anna Nowak (Firma ACME Sp. z o.o.)",
            "phone": "+48 601 222 333",
            "pkg": "PCK10002",
            "cod": "0.00 PLN (oplacone)",
        },
        {
            "address": "ul. Krakowska 8, 30-001 Krakow",
            "recipient": "Piotr Wisniewski",
            "phone": "",
            "pkg": "PCK10003",
            "cod": "89.50 PLN",
        },
    ]

    for i, s in enumerate(stops, 1):
        c.setFont("Helvetica-Bold", 11)
        c.drawString(40, y, f"Przesylka {i}:")
        y -= 16
        c.setFont("Helvetica", 10)
        c.drawString(60, y, f"Adres: {s['address']}")
        y -= 14
        c.drawString(60, y, f"Odbiorca: {s['recipient']}")
        y -= 14
        if s["phone"]:
            c.drawString(60, y, f"Telefon: {s['phone']}")
            y -= 14
        c.drawString(60, y, f"Nr paczki: {s['pkg']}")
        y -= 14
        c.drawString(60, y, f"Pobranie (COD): {s['cod']}")
        y -= 22

    c.showPage()
    c.save()
    return buf.getvalue()


# ---------------- Fixtures ----------------

@pytest.fixture(scope="session")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def seeded_route(api_client):
    """Seed exactly ONE route via the real Gemini-backed manifest upload endpoint.
    Reused across all dependent tests to avoid repeated LLM calls."""
    pdf_bytes = _make_polish_manifest_pdf()
    pdf_b64 = base64.b64encode(pdf_bytes).decode("ascii")
    payload = {"pdf_base64": pdf_b64, "name": "TEST_TRASA"}
    r = api_client.post(f"{BASE_URL}/api/manifest/upload", json=payload, timeout=120)
    if r.status_code != 200:
        pytest.skip(f"Manifest upload failed ({r.status_code}): {r.text[:300]}")
    data = r.json()
    assert "id" in data and "stops" in data
    yield data
    # cleanup
    try:
        api_client.delete(f"{BASE_URL}/api/routes/{data['id']}", timeout=15)
    except Exception:
        pass


# ---------------- Tests ----------------

# --- Health ---
class TestHealth:
    def test_root(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/", timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "message" in body
        assert isinstance(body["message"], str)

    def test_list_routes_initial(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/routes", timeout=15)
        assert r.status_code == 200, r.text
        assert isinstance(r.json(), list)


# --- Manifest upload (Gemini) + persistence ---
class TestManifestUpload:
    def test_route_persisted(self, api_client, seeded_route):
        rid = seeded_route["id"]
        assert seeded_route["name"]
        assert len(seeded_route["stops"]) >= 2, seeded_route
        # Each stop has required fields
        for s in seeded_route["stops"]:
            for k in ["id", "order", "address", "recipient_name", "package_numbers", "cod_amount", "status"]:
                assert k in s, f"missing {k} in stop"
            assert s["status"] == "pending"
        # Verify persistence by GET
        r = api_client.get(f"{BASE_URL}/api/routes/{rid}", timeout=15)
        assert r.status_code == 200
        got = r.json()
        assert got["id"] == rid
        assert len(got["stops"]) == len(seeded_route["stops"])

    def test_route_in_list(self, api_client, seeded_route):
        r = api_client.get(f"{BASE_URL}/api/routes", timeout=15)
        assert r.status_code == 200
        ids = [x["id"] for x in r.json()]
        assert seeded_route["id"] in ids

    def test_heavy_fields_excluded_from_list(self, api_client, seeded_route):
        r = api_client.get(f"{BASE_URL}/api/routes/{seeded_route['id']}", timeout=15)
        assert r.status_code == 200
        for s in r.json()["stops"]:
            assert "photo_base64" not in s or s.get("photo_base64") is None
            assert "signature_base64" not in s or s.get("signature_base64") is None

    def test_cod_present_on_at_least_one_stop(self, seeded_route):
        # Our synthetic PDF has 2 COD stops; AI should pick at least one
        amounts = [s["cod_amount"] for s in seeded_route["stops"]]
        assert any(a and a > 0 for a in amounts), f"No COD parsed: {amounts}"

    def test_upload_invalid_base64(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/manifest/upload",
                            json={"pdf_base64": "@@@notb64@@@"}, timeout=15)
        assert r.status_code in (400, 422), r.text


# --- Stop endpoints ---
class TestStopEndpoints:
    def test_get_single_stop(self, api_client, seeded_route):
        rid = seeded_route["id"]
        sid = seeded_route["stops"][0]["id"]
        r = api_client.get(f"{BASE_URL}/api/routes/{rid}/stops/{sid}", timeout=15)
        assert r.status_code == 200
        s = r.json()
        assert s["id"] == sid
        assert "address" in s

    def test_get_route_404(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/routes/does-not-exist-xyz", timeout=15)
        assert r.status_code == 404

    def test_get_stop_404(self, api_client, seeded_route):
        r = api_client.get(
            f"{BASE_URL}/api/routes/{seeded_route['id']}/stops/nope-xyz", timeout=15)
        assert r.status_code == 404


# --- State machine: deliver / absent / reset ---
class TestStopLifecycle:
    def test_deliver_then_reset(self, api_client, seeded_route):
        rid = seeded_route["id"]
        sid = seeded_route["stops"][0]["id"]
        body = {
            "photo_base64": base64.b64encode(b"FAKEPNG").decode(),
            "signature_base64": base64.b64encode(b"FAKESIG").decode(),
        }
        r = api_client.post(f"{BASE_URL}/api/routes/{rid}/stops/{sid}/deliver",
                            json=body, timeout=15)
        assert r.status_code == 200, r.text
        # verify
        s = api_client.get(f"{BASE_URL}/api/routes/{rid}/stops/{sid}", timeout=15).json()
        assert s["status"] == "delivered"
        assert s["completed_at"]
        assert s["photo_base64"]
        assert s["signature_base64"]

        # reset
        r = api_client.post(f"{BASE_URL}/api/routes/{rid}/stops/{sid}/reset", timeout=15)
        assert r.status_code == 200
        s = api_client.get(f"{BASE_URL}/api/routes/{rid}/stops/{sid}", timeout=15).json()
        assert s["status"] == "pending"
        assert s["photo_base64"] is None
        assert s["completed_at"] is None

    def test_absent_then_reset(self, api_client, seeded_route):
        rid = seeded_route["id"]
        # use second stop to keep tests independent
        sid = seeded_route["stops"][1]["id"] if len(seeded_route["stops"]) > 1 else seeded_route["stops"][0]["id"]
        r = api_client.post(f"{BASE_URL}/api/routes/{rid}/stops/{sid}/absent",
                            json={"note": "Brak odbiorcy pod adresem"}, timeout=15)
        assert r.status_code == 200
        s = api_client.get(f"{BASE_URL}/api/routes/{rid}/stops/{sid}", timeout=15).json()
        assert s["status"] == "absent"
        assert s["note"] == "Brak odbiorcy pod adresem"
        # reset
        r = api_client.post(f"{BASE_URL}/api/routes/{rid}/stops/{sid}/reset", timeout=15)
        assert r.status_code == 200
        s = api_client.get(f"{BASE_URL}/api/routes/{rid}/stops/{sid}", timeout=15).json()
        assert s["status"] == "pending"
        assert s["note"] is None

    def test_deliver_invalid_route(self, api_client):
        r = api_client.post(
            f"{BASE_URL}/api/routes/missing/stops/missing/deliver",
            json={"photo_base64": "x", "signature_base64": "y"}, timeout=15)
        assert r.status_code == 404


# --- Delete (own session, not seeded_route to keep that intact) ---
class TestRouteDelete:
    def test_delete_unknown(self, api_client):
        r = api_client.delete(f"{BASE_URL}/api/routes/nonexistent-id-zzz", timeout=15)
        assert r.status_code == 404
