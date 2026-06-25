"""Tests for the Polish KSIĘGA ODDAWCZA XLS manifest parser (iteration 11)."""
import base64
import os
import re
import pytest
import requests

BASE_URL = os.environ['EXPO_PUBLIC_BACKEND_URL'].rstrip('/') if os.environ.get('EXPO_PUBLIC_BACKEND_URL') else None
if not BASE_URL:
    # Fall back to frontend .env
    with open('/app/frontend/.env') as f:
        for line in f:
            if line.startswith('EXPO_PUBLIC_BACKEND_URL='):
                BASE_URL = line.split('=', 1)[1].strip().strip('"').rstrip('/')
                break

XLS_URL = "https://customer-assets.emergentagent.com/job_courier-nav-4/artifacts/jvsolzfl_2026-06-25_raport_KOP.xls"


@pytest.fixture(scope="module")
def xls_b64():
    r = requests.get(XLS_URL, timeout=30)
    assert r.status_code == 200, f"Could not download xls: {r.status_code}"
    assert r.content[:4] == b"\xd0\xcf\x11\xe0", "Not an XLS (OLE2) file"
    return base64.b64encode(r.content).decode()


@pytest.fixture(scope="module")
def uploaded_route(xls_b64):
    """Upload + geocode of 132 stops can exceed the ingress 60s timeout, so we
    POST to the public URL first and fall back to the in-cluster backend on 502.
    Both paths hit the same backend instance."""
    payload = {"pdf_base64": xls_b64, "name": "TEST_KOP_iter11"}
    try:
        r = requests.post(f"{BASE_URL}/api/manifest/upload", json=payload, timeout=180)
    except requests.RequestException:
        r = None
    if r is None or r.status_code in (502, 504):
        print(f"Public URL returned {getattr(r,'status_code', 'no-response')}, retrying via localhost:8001")
        r = requests.post("http://localhost:8001/api/manifest/upload", json=payload, timeout=240)
    assert r.status_code == 200, f"Upload failed: {r.status_code} {r.text[:500]}"
    return r.json()


# --- Basic plumbing -----------------------------------------------------------

def test_health():
    r = requests.get(f"{BASE_URL}/api/", timeout=15)
    assert r.status_code == 200


# --- XLS parser core ----------------------------------------------------------

def test_xls_upload_parses_many_stops(uploaded_route):
    route = uploaded_route
    assert "id" in route
    assert isinstance(route.get("stops"), list)
    n = len(route["stops"])
    # The sample file has 132 deliveries; expect at least 100
    assert n >= 100, f"Expected >=100 stops, got {n}"
    print(f"Parsed {n} stops")


def test_stop_schema(uploaded_route):
    stops = uploaded_route["stops"]
    s = stops[0]
    expected_keys = {
        "id", "order", "address", "recipient_name", "phone",
        "package_numbers", "cod_amount", "extra_fees", "is_cod",
        "lat", "lng", "status",
    }
    missing = expected_keys - set(s.keys())
    assert not missing, f"Missing keys: {missing}"
    assert isinstance(s["package_numbers"], list)
    assert isinstance(s["cod_amount"], (int, float))
    assert isinstance(s["extra_fees"], (int, float))
    assert isinstance(s["is_cod"], bool)


def test_no_phone_leak_in_recipient_or_address(uploaded_route):
    """recipient_name must have no comma/no phone. address must not contain 'tel' or raw 9-digit phones."""
    phone_in_field = re.compile(r"\b\d{3}[\s\-]?\d{3}[\s\-]?\d{3}\b")
    tel_marker = re.compile(r"\btel(?:efon)?\b", re.IGNORECASE)
    bad = []
    for s in uploaded_route["stops"]:
        if "," in s["recipient_name"]:
            bad.append(("recipient_has_comma", s["order"], s["recipient_name"]))
        if phone_in_field.search(s["recipient_name"]):
            bad.append(("recipient_has_phone", s["order"], s["recipient_name"]))
        if tel_marker.search(s["address"] or ""):
            bad.append(("address_has_tel", s["order"], s["address"]))
        if phone_in_field.search(s["address"] or ""):
            bad.append(("address_has_phone", s["order"], s["address"]))
    assert not bad, f"Phone/tel leaks: {bad[:5]} (total {len(bad)})"


def test_phone_format_when_present(uploaded_route):
    """If phone present, must match +48 XXX XXX XXX."""
    phone_re = re.compile(r"^\+48 \d{3} \d{3} \d{3}$")
    have_phone = 0
    for s in uploaded_route["stops"]:
        if s["phone"]:
            have_phone += 1
            assert phone_re.match(s["phone"]), f"Bad phone format: {s['phone']!r} on stop {s['order']}"
    print(f"{have_phone} stops have phone numbers")
    assert have_phone > 0, "Expected at least one stop with a phone number"


def test_is_cod_consistency(uploaded_route):
    """is_cod must be true whenever cod_amount > 0."""
    for s in uploaded_route["stops"]:
        if s["cod_amount"] > 0:
            assert s["is_cod"] is True, f"stop {s['order']} has cod={s['cod_amount']} but is_cod=False"


def test_cod_stops_exist(uploaded_route):
    cods = [s for s in uploaded_route["stops"] if s["is_cod"]]
    assert len(cods) > 0, "Expected COD stops"
    print(f"{len(cods)} COD stops")


def test_geocoding_attempted(uploaded_route):
    """At least 50% of stops should have lat/lng (Photon)."""
    stops = uploaded_route["stops"]
    geocoded = sum(1 for s in stops if s.get("lat") is not None and s.get("lng") is not None)
    pct = geocoded / len(stops) if stops else 0
    print(f"Geocoded {geocoded}/{len(stops)} = {pct:.0%}")
    assert pct >= 0.5, f"Only {pct:.0%} geocoded"


# --- Spot checks (from review request) ----------------------------------------

def test_spot_stop_2_andrzej_walczak(uploaded_route):
    stops = uploaded_route["stops"]
    s2 = next((s for s in stops if s["order"] == 2), None)
    assert s2 is not None, "No stop with order=2"
    print(f"Stop 2: {s2['recipient_name']!r} phone={s2['phone']!r} cod={s2['cod_amount']} fees={s2['extra_fees']} is_cod={s2['is_cod']}")
    assert "Walczak" in s2["recipient_name"], f"Expected Walczak, got {s2['recipient_name']!r}"
    assert "Andrzej" in s2["recipient_name"]
    assert s2["cod_amount"] == 186.0, f"Expected cod=186.0 got {s2['cod_amount']}"
    assert s2["extra_fees"] == 0.0
    assert s2["is_cod"] is True
    # Phone should be there in +48 XXX XXX XXX format
    assert s2["phone"].startswith("+48 "), f"Phone format wrong: {s2['phone']!r}"


def test_spot_stop_3_miroslaw_malinowski(uploaded_route):
    stops = uploaded_route["stops"]
    s3 = next((s for s in stops if s["order"] == 3), None)
    assert s3 is not None, "No stop with order=3"
    print(f"Stop 3: {s3['recipient_name']!r} cod={s3['cod_amount']}")
    assert "Malinowski" in s3["recipient_name"]
    assert "Miros" in s3["recipient_name"]  # Mirosław (poss. encoding)
    assert abs(s3["cod_amount"] - 77.98) < 0.01, f"Expected cod=77.98 got {s3['cod_amount']}"


# --- File format dispatch -----------------------------------------------------

def test_invalid_format_rejected():
    """Non-PDF/XLS/XLSX bytes must be rejected with 400."""
    junk = base64.b64encode(b"\x00" * 500).decode()
    r = requests.post(f"{BASE_URL}/api/manifest/upload",
                      json={"pdf_base64": junk, "name": "TEST_invalid"},
                      timeout=30)
    assert r.status_code == 400, f"Expected 400, got {r.status_code} ({r.text[:200]})"


def test_too_small_rejected():
    tiny = base64.b64encode(b"x").decode()
    r = requests.post(f"{BASE_URL}/api/manifest/upload",
                      json={"pdf_base64": tiny, "name": "TEST_tiny"},
                      timeout=30)
    assert r.status_code == 400


# --- Cleanup ------------------------------------------------------------------

def test_cleanup_uploaded(uploaded_route):
    rid = uploaded_route["id"]
    r = requests.delete(f"{BASE_URL}/api/routes/{rid}", timeout=15)
    assert r.status_code == 200
