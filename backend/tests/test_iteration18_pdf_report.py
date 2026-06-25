"""Iteration 18 regression — End-of-day PDF report endpoint.

Tests:
- GET /api/routes/{id}/report → 200 application/pdf with valid PDF bytes
- ?courier=<name> variant returns same content-type with PDF magic bytes
- non-existent route → 404
- Content-Disposition header includes filename
- PDF size > 1KB
"""
import os
import pytest
import requests

BASE_URL = (os.environ.get("EXPO_PUBLIC_BACKEND_URL") or "http://localhost:8001").rstrip("/")
ROUTE_A = "8c0a5cbe-8372-4ea5-a678-4191b163c10b"  # 167 stops reference route


@pytest.fixture(scope="module")
def api_client():
    s = requests.Session()
    return s


class TestPdfReport:
    """End-of-day PDF report endpoint regression."""

    def test_report_200_pdf_no_courier(self, api_client):
        """Default call returns 200 with application/pdf and PDF magic bytes."""
        r = api_client.get(f"{BASE_URL}/api/routes/{ROUTE_A}/report", timeout=60)
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:200]}"
        assert r.headers.get("content-type", "").startswith("application/pdf"), \
            f"Bad content-type: {r.headers.get('content-type')}"
        # Magic bytes
        assert r.content[:5] == b"%PDF-", f"Not a valid PDF — first bytes: {r.content[:8]!r}"
        # %%EOF marker should appear somewhere near the end
        assert b"%%EOF" in r.content[-1024:], "PDF missing %%EOF trailer"

    def test_report_size_above_1kb(self, api_client):
        """PDF should not be empty/skeleton — must include content tables/images."""
        r = api_client.get(f"{BASE_URL}/api/routes/{ROUTE_A}/report", timeout=60)
        assert r.status_code == 200
        assert len(r.content) > 1024, f"PDF too small ({len(r.content)} bytes) — likely empty"

    def test_report_content_disposition_filename(self, api_client):
        """Content-Disposition header must include filename for download."""
        r = api_client.get(f"{BASE_URL}/api/routes/{ROUTE_A}/report", timeout=60)
        assert r.status_code == 200
        cd = r.headers.get("content-disposition", "")
        assert "filename=" in cd.lower(), f"No filename in Content-Disposition: {cd}"
        assert ".pdf" in cd.lower(), f"Filename missing .pdf extension: {cd}"
        # filename should be derived from first 8 chars of route id
        assert ROUTE_A[:8] in cd, f"Expected route id prefix in filename: {cd}"

    def test_report_with_courier_name(self, api_client):
        """?courier=<name> variant returns 200 + valid PDF."""
        r = api_client.get(
            f"{BASE_URL}/api/routes/{ROUTE_A}/report",
            params={"courier": "Jan Kowalski"},
            timeout=60,
        )
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:200]}"
        assert r.headers.get("content-type", "").startswith("application/pdf")
        assert r.content[:5] == b"%PDF-"
        assert len(r.content) > 1024

    def test_report_404_for_unknown_route(self, api_client):
        """Non-existent route id returns 404 (not a 500/200)."""
        r = api_client.get(
            f"{BASE_URL}/api/routes/00000000-0000-0000-0000-000000000000/report",
            timeout=15,
        )
        assert r.status_code == 404, f"Expected 404, got {r.status_code}: {r.text[:200]}"

    def test_report_pdf_includes_pdf_objects(self, api_client):
        """Sanity: PDF should contain typical structural keywords for content presence."""
        r = api_client.get(f"{BASE_URL}/api/routes/{ROUTE_A}/report", timeout=60)
        assert r.status_code == 200
        body = r.content
        # ReportLab-generated PDFs always include these markers
        assert b"/Type" in body
        assert b"endobj" in body
        # Should have multiple pages worth of content for a 167-stop route
        assert body.count(b"endobj") > 5, "PDF has too few objects — likely empty"
