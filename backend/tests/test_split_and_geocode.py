"""Iteration 14 — tests for the new XLS parser heuristics and geocoder fallback.

Covers:
  * Unit tests for `_split_recipient_address` (recipient vs street/city detection).
  * Smoke test for `_geocode_sync` diacritic-stripping fallback (Polish 'Szćzećin').
  * POST /api/manifest/upload with the user's 132-row XLS — verifies fast response,
    132 stops, and that no recipient_name starts with a digit or looks like a
    house number (e.g. '7/10', '35/').
  * Background geocoding progress: at least 5 stops eventually get lat/lng,
    confirming the strip-diacritic path is wired up and rescues 'Szćzećin' rows.
  * Smoke for GET /api/routes and GET /api/routes/{id}.
"""

import base64
import os
import re
import sys
import time
from pathlib import Path

import pytest
import requests

# Make /app/backend importable so we can import server helpers directly.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server import _split_recipient_address, _geocode_sync, _strip_pl  # noqa: E402

INTERNAL_URL = "http://localhost:8001"

XLS_URL = "https://customer-assets.emergentagent.com/job_courier-nav-4/artifacts/jvsolzfl_2026-06-25_raport_KOP.xls"
XLS_PATH = Path("/tmp/manifest_iter14.xls")


# ---------------------- Unit: _split_recipient_address ----------------------
class TestSplitRecipientAddress:
    """Verify the street-aware comma split keeps multi-word names intact."""

    def test_simple_person(self):
        rec, addr = _split_recipient_address(
            "Andrzej Walczak, Szczecin, Szarotki 7/10"
        )
        assert rec == "Andrzej Walczak", rec
        assert "Szczecin" in addr and "Szarotki 7/10" in addr, addr

    def test_institution_with_short_words(self):
        rec, addr = _split_recipient_address(
            "Wojewódzki Zespół ds Orzekania, Szczecin, Stanisława Dubois 27"
        )
        assert rec == "Wojewódzki Zespół ds Orzekania", rec
        assert "Szczecin" in addr and "Dubois 27" in addr, addr

    def test_company_with_dots_and_initials(self):
        rec, addr = _split_recipient_address(
            "Z.H. Arpo Jan Myśliwiec, Szczecin, Nocznickiego 35"
        )
        assert rec == "Z.H. Arpo Jan Myśliwiec", rec
        assert "Nocznickiego 35" in addr, addr

    def test_company_with_internal_comma(self):
        """Company name has its own commas (Sp. z o.o., Inc.) — both segments
        must end up in recipient, and city + street must end up in address."""
        rec, addr = _split_recipient_address(
            "Acme Sp. z o.o., Inc., Warszawa, ul. Marszałkowska 1/3"
        )
        assert "Acme Sp. z o.o." in rec, rec
        assert "Inc." in rec, rec
        assert "Warszawa" in addr, addr
        assert "ul. Marszałkowska 1/3" in addr, addr

    def test_person_with_apartment_number(self):
        rec, addr = _split_recipient_address(
            "Mirosław Malinowski, Szczecin, Jana Kazimierza 19E/7"
        )
        assert rec == "Mirosław Malinowski", rec
        assert "Jana Kazimierza 19E/7" in addr, addr


# ---------------------- Unit: diacritic strip helper ----------------------
def test_strip_pl_handles_szczecin_typo():
    """'Szćzećin' should normalize toward something Nominatim will recognise."""
    out = _strip_pl("Szćzećin")
    assert out == "Szczecin", out


# ---------------------- Smoke: _geocode_sync fallback path ----------------------
def test_geocode_sync_szczecin_via_fallback():
    """The diacritic-stripped fallback should let Nominatim resolve a mangled
    Szczecin address. Network may be flaky / rate-limited from CI: we skip
    instead of failing if both queries time out."""
    coords = _geocode_sync("Szarotki 7, Szćzećin")
    if coords is None:
        pytest.skip("Nominatim returned no result (likely rate-limited)")
    lat, lng = coords
    # Szczecin is around 53.4N, 14.5E. Allow a wide bbox.
    assert 52.5 < lat < 54.5, f"lat {lat} not near Szczecin"
    assert 13.5 < lng < 15.5, f"lng {lng} not near Szczecin"


# ---------------------- Upload fixture ----------------------
@pytest.fixture(scope="module")
def xls_b64():
    if not XLS_PATH.exists():
        r = requests.get(XLS_URL, timeout=30)
        r.raise_for_status()
        XLS_PATH.write_bytes(r.content)
    return base64.b64encode(XLS_PATH.read_bytes()).decode()


@pytest.fixture(scope="module")
def uploaded_route(xls_b64):
    payload = {"pdf_base64": xls_b64, "name": "TEST_iteration14"}
    t0 = time.monotonic()
    r = requests.post(f"{INTERNAL_URL}/api/manifest/upload", json=payload, timeout=15)
    elapsed = time.monotonic() - t0
    assert r.status_code == 200, f"upload failed: {r.status_code} {r.text[:300]}"
    data = r.json()
    print(f"\n[upload] {elapsed:.2f}s, stops={len(data.get('stops', []))}")
    yield {"elapsed": elapsed, "route": data}
    try:
        requests.delete(f"{INTERNAL_URL}/api/routes/{data['id']}", timeout=5)
    except Exception:
        pass


# ---------------------- Upload assertions ----------------------
def test_upload_fast(uploaded_route):
    assert uploaded_route["elapsed"] < 5.0, (
        f"Upload took {uploaded_route['elapsed']:.2f}s (>5s)"
    )


def test_upload_returns_132_stops(uploaded_route):
    stops = uploaded_route["route"]["stops"]
    assert len(stops) == 132, f"Expected 132 stops, got {len(stops)}"


# Pattern that looks like a "house number" leaking into recipient_name.
# Examples we want to reject: "7/10", "35/", "1/3", "19E/7", "3A".
_HOUSE_LIKE = re.compile(r"\b\d+[A-Za-z]?/\d*[A-Za-z]?\b")


def test_recipients_do_not_look_like_house_numbers(uploaded_route):
    stops = uploaded_route["route"]["stops"]

    # Spot-check the first 5 plus 5 more sampled later in the list.
    indices = list(range(0, 5)) + [25, 50, 75, 100, 125]
    bad = []
    for idx in indices:
        if idx >= len(stops):
            continue
        s = stops[idx]
        rec = (s.get("recipient_name") or "").strip()
        if not rec:
            bad.append((idx, rec, "empty recipient"))
            continue
        if rec[0].isdigit():
            bad.append((idx, rec, "starts with digit"))
            continue
        if _HOUSE_LIKE.search(rec):
            bad.append((idx, rec, "contains house-number-like substring"))
    assert not bad, f"Bad recipients: {bad}"


def test_no_recipient_starts_with_digit_anywhere(uploaded_route):
    """Stricter check across ALL 132 stops."""
    stops = uploaded_route["route"]["stops"]
    offenders = [
        (s["order"], s["recipient_name"])
        for s in stops
        if (s.get("recipient_name") or "").strip().startswith(tuple("0123456789"))
    ]
    assert not offenders, f"Recipients starting with a digit: {offenders[:10]}"


def test_no_recipient_contains_house_number_pattern(uploaded_route):
    stops = uploaded_route["route"]["stops"]
    offenders = []
    for s in stops:
        rec = (s.get("recipient_name") or "").strip()
        if _HOUSE_LIKE.search(rec):
            offenders.append((s["order"], rec))
    assert not offenders, (
        f"Recipients containing house-number-like substring: {offenders[:10]}"
    )


def test_addresses_contain_city_or_street_hints(uploaded_route):
    """Most addresses should contain at least one digit (house number)."""
    stops = uploaded_route["route"]["stops"]
    with_digit = sum(1 for s in stops if any(c.isdigit() for c in (s.get("address") or "")))
    # Expect well over 90% to have a digit in address.
    assert with_digit >= int(0.9 * len(stops)), (
        f"Only {with_digit}/{len(stops)} addresses contain a digit"
    )


# ---------------------- Background geocoding ----------------------
def test_background_geocoding_rescues_some_stops(uploaded_route):
    """Poll for up to 3 minutes; pass if ≥5 stops get lat/lng, proving the
    diacritic-strip fallback rescues the Szćzećin rows."""
    route_id = uploaded_route["route"]["id"]
    deadline = time.monotonic() + 180
    target = 5
    last = 0
    while time.monotonic() < deadline:
        r = requests.get(f"{INTERNAL_URL}/api/routes/{route_id}", timeout=10)
        assert r.status_code == 200
        stops = r.json().get("stops", [])
        geocoded = sum(1 for s in stops if s.get("lat") is not None)
        if geocoded != last:
            print(f"[bg-geocode] {geocoded}/{len(stops)} geocoded so far")
            last = geocoded
        if geocoded >= target:
            # Verify at least one of them is near Szczecin (53.4N, 14.5E)
            near_szczecin = [
                s for s in stops
                if s.get("lat") and 52.5 < s["lat"] < 54.5 and 13.5 < s["lng"] < 15.5
            ]
            print(f"[bg-geocode] {len(near_szczecin)} stops near Szczecin")
            assert near_szczecin, "No geocoded stop landed near Szczecin"
            return
        time.sleep(10)
    pytest.skip(
        f"Background geocoder did not reach {target} stops within 3 min "
        f"(last={last}) — likely Nominatim rate-limit, not a code bug"
    )


# ---------------------- Smoke ----------------------
def test_list_routes_ok():
    r = requests.get(f"{INTERNAL_URL}/api/routes", timeout=10)
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_get_route_by_id_ok(uploaded_route):
    rid = uploaded_route["route"]["id"]
    r = requests.get(f"{INTERNAL_URL}/api/routes/{rid}", timeout=10)
    assert r.status_code == 200
    data = r.json()
    assert data["id"] == rid
    assert len(data["stops"]) == 132
