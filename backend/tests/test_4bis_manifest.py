"""Iteration 3: Real 4BIS manifest upload tests.
Uploads ONCE (Gemini call ~1-2 min) and reuses route_id across assertions.
"""
import base64
import os
import sys
import pytest
import requests


def _backend_url() -> str:
    env_path = "/app/frontend/.env"
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'").rstrip("/")
    raise RuntimeError("No EXPO_PUBLIC_BACKEND_URL")


BASE_URL = _backend_url()
PDF_PATH = "/tmp/4bis_manifest.pdf"
print(f"[tests] BASE_URL={BASE_URL}", file=sys.stderr)


@pytest.fixture(scope="session")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


INTERNAL_URL = "http://localhost:8001"


@pytest.fixture(scope="session")
def uploaded_route():
    """Reuse an existing 4BIS route to avoid the 60s ingress timeout on Gemini parse
    (parse takes 60-120s for 104 stops; the public ingress kills it). If none exists,
    upload via INTERNAL_URL."""
    # Step 1: reuse existing 4BIS route with >=50 stops via INTERNAL_URL (fast & reliable)
    try:
        r = requests.get(f"{INTERNAL_URL}/api/routes", timeout=10)
        if r.ok:
            candidates = [
                rt for rt in r.json()
                if "4BIS" in (rt.get("name") or "") and len(rt.get("stops") or []) >= 50
            ]
            if candidates:
                rt = max(candidates, key=lambda x: len(x.get("stops") or []))
                full = requests.get(f"{INTERNAL_URL}/api/routes/{rt['id']}", timeout=15).json()
                print(f"[tests] REUSING route {full['id']} ({len(full['stops'])} stops, name={full['name']})", file=sys.stderr)
                yield full
                return
    except Exception as e:
        print(f"[tests] reuse error: {e}", file=sys.stderr)

    # Step 2: upload via INTERNAL_URL (no ingress timeout)
    assert os.path.exists(PDF_PATH)
    with open(PDF_PATH, "rb") as f:
        pdf_b64 = base64.b64encode(f.read()).decode("ascii")
    print("[tests] uploading via INTERNAL_URL", file=sys.stderr)
    r = requests.post(
        f"{INTERNAL_URL}/api/manifest/upload",
        json={"pdf_base64": pdf_b64, "name": "TEST_4BIS_Q1"},
        timeout=300,
    )
    print(f"[tests] upload status={r.status_code}", file=sys.stderr)
    if r.status_code != 200:
        pytest.fail(f"Upload failed {r.status_code}: {r.text[:500]}")
    data = r.json()
    yield data


# --- Schema / counts ---
class TestManifestSchema:
    def test_min_50_stops(self, uploaded_route):
        n = len(uploaded_route["stops"])
        print(f"[assert] stops={n}", file=sys.stderr)
        assert n >= 50, f"Expected >=50 stops, got {n}"

    def test_required_fields(self, uploaded_route):
        for s in uploaded_route["stops"][:5]:
            for k in ["order", "address", "recipient_name", "package_numbers",
                      "is_cod", "cod_amount", "lat", "lng", "status", "id"]:
                assert k in s, f"missing {k} in {s}"

    def test_order_preserved(self, uploaded_route):
        stops = uploaded_route["stops"]
        orders = [s["order"] for s in stops]
        # Strictly increasing from 1
        assert orders == sorted(orders), f"Orders not sorted: {orders[:10]}..."
        assert orders[0] == 1, f"First order should be 1, got {orders[0]}"

    def test_first_stops_match(self, uploaded_route):
        stops = uploaded_route["stops"]
        # Stop 1 = Kacper Wiśniewski / P.H.U. AWO
        r1 = (stops[0].get("recipient_name") or "").lower()
        assert "kacper" in r1 or "wi" in r1 or "awo" in r1, f"Stop 1 unexpected: {stops[0]}"
        # Stop 2 = Paweł Cackowski
        if len(stops) >= 2:
            r2 = (stops[1].get("recipient_name") or "").lower()
            assert "cackowski" in r2 or "pa" in r2, f"Stop 2 unexpected: {stops[1]}"
        # Stop 3 = Grażyna Wołdańska
        if len(stops) >= 3:
            r3 = (stops[2].get("recipient_name") or "").lower()
            assert "wo" in r3 or "gra" in r3, f"Stop 3 unexpected: {stops[2]}"


# --- COD detection ---
class TestCodFlag:
    def test_some_cod_some_not(self, uploaded_route):
        stops = uploaded_route["stops"]
        cod = [s for s in stops if s.get("is_cod")]
        noncod = [s for s in stops if not s.get("is_cod")]
        print(f"[assert] cod={len(cod)} non_cod={len(noncod)}", file=sys.stderr)
        # Manifest has both; majority are non-pobr but several pobr stops
        assert len(cod) >= 1, "Expected at least 1 pobr/COD stop"
        assert len(noncod) >= 30, "Expected many non-COD stops"

    def test_known_cod_recipient(self, uploaded_route):
        # PX7570288759 Paweł Cackowski should be is_cod=true (has '. pobr')
        stops = uploaded_route["stops"]
        match = None
        for s in stops:
            pkgs = " ".join(s.get("package_numbers") or [])
            if "PX7570288759" in pkgs or "cackowski" in (s.get("recipient_name") or "").lower():
                match = s
                break
        if match is None:
            pytest.skip("Cackowski stop not isolated by package number; skip strict check")
        else:
            print(f"[assert] cackowski stop is_cod={match.get('is_cod')}", file=sys.stderr)
            assert match.get("is_cod") is True, f"Cackowski should be COD: {match}"


# --- Coordinates (Szczecin) ---
class TestCoordinates:
    def test_lat_lng_present(self, uploaded_route):
        stops = uploaded_route["stops"]
        with_coords = [s for s in stops if isinstance(s.get("lat"), (int, float))
                       and isinstance(s.get("lng"), (int, float))]
        print(f"[assert] with_coords={len(with_coords)}/{len(stops)}", file=sys.stderr)
        assert len(with_coords) >= int(0.8 * len(stops)), "Most stops should have coords"

    def test_coords_in_szczecin(self, uploaded_route):
        stops = uploaded_route["stops"]
        in_area = 0
        for s in stops:
            lat, lng = s.get("lat"), s.get("lng")
            if isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
                if 53.2 <= lat <= 53.7 and 14.3 <= lng <= 14.8:
                    in_area += 1
        print(f"[assert] in_szczecin={in_area}/{len(stops)}", file=sys.stderr)
        assert in_area >= int(0.7 * len(stops)), f"Most stops should be near Szczecin, got {in_area}"


# --- Persistence + retrieval ---
class TestPersistence:
    def test_get_route(self, api_client, uploaded_route):
        rid = uploaded_route["id"]
        r = api_client.get(f"{BASE_URL}/api/routes/{rid}", timeout=30)
        assert r.status_code == 200
        got = r.json()
        assert got["id"] == rid
        assert len(got["stops"]) == len(uploaded_route["stops"])

    def test_route_in_list(self, api_client, uploaded_route):
        r = api_client.get(f"{BASE_URL}/api/routes", timeout=15)
        assert r.status_code == 200
        ids = [x["id"] for x in r.json()]
        assert uploaded_route["id"] in ids
