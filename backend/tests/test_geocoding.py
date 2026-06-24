"""Tests for geocoding fix (Photon + Nominatim) on seeded route."""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/") or \
           "https://courier-nav-4.preview.emergentagent.com"
ROUTE_ID = "4fca5350-ddf4-40cb-8028-aae36f8d257d"


@pytest.fixture(scope="module")
def route_data():
    r = requests.get(f"{BASE_URL}/api/routes/{ROUTE_ID}", timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


# Geocoding uniqueness: most coordinates should be distinct after Photon/Nominatim fix
def test_route_has_104_stops(route_data):
    assert len(route_data["stops"]) == 104


def test_geocoding_unique_coords_at_least_50(route_data):
    coords = {(round(s["lat"], 4), round(s["lng"], 4)) for s in route_data["stops"]}
    assert len(coords) >= 50, f"only {len(coords)} unique coords (expected >=50)"


# First stop sanity check (Antosiewicza 1 should be in north Szczecin near 53.441)
def test_stop_order_1_coords(route_data):
    s = next(x for x in route_data["stops"] if x["order"] == 1)
    assert "Antosiewicza" in s["address"]
    assert abs(s["lat"] - 53.441) < 0.01, s["lat"]


# Second stop sanity check (1 Maja 7/7 ~ 53.441, 14.566)
def test_stop_order_2_coords(route_data):
    s = next(x for x in route_data["stops"] if x["order"] == 2)
    assert "1 Maja" in s["address"]
    assert abs(s["lat"] - 53.441) < 0.01, s["lat"]
    assert abs(s["lng"] - 14.566) < 0.02, s["lng"]


# Not all stops collapsed at Szczecin city-centre (53.4285, 14.5528) Gemini hallucination
def test_not_all_at_szczecin_centre(route_data):
    bad = sum(1 for s in route_data["stops"]
              if abs(s["lat"] - 53.4285) < 0.0005 and abs(s["lng"] - 14.5528) < 0.0005)
    assert bad < 5, f"{bad} stops still pinned to old Gemini centre"
