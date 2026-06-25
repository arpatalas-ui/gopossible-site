"""End-of-day PDF report generation using ReportLab."""
import base64
import io
from datetime import datetime
from typing import List

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Image
)


def _img_from_b64(b64: str, max_w: float = 60 * mm, max_h: float = 40 * mm):
    """Decode base64 image safely. Returns None on any failure."""
    if not b64:
        return None
    try:
        # Strip data URI prefix if present
        if "," in b64:
            b64 = b64.split(",", 1)[1]
        raw = base64.b64decode(b64)
        bio = io.BytesIO(raw)
        img = Image(bio)
        # Scale to fit
        iw, ih = img.imageWidth, img.imageHeight
        ratio = min(max_w / iw, max_h / ih)
        img.drawWidth = iw * ratio
        img.drawHeight = ih * ratio
        return img
    except Exception:
        return None


def build_route_pdf(route: dict, courier_name: str = "") -> bytes:
    """Generate the end-of-day report PDF for a given route doc (Mongo dict)."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=14 * mm, rightMargin=14 * mm,
        topMargin=14 * mm, bottomMargin=14 * mm,
        title=f"Raport trasy — {route.get('name', '')}",
    )

    styles = getSampleStyleSheet()
    H1 = ParagraphStyle("H1", parent=styles["Heading1"], fontSize=20, textColor=colors.HexColor("#1F1F1F"), spaceAfter=4)
    H2 = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=13, textColor=colors.HexColor("#E63329"), spaceBefore=8, spaceAfter=4)
    Body = ParagraphStyle("Body", parent=styles["BodyText"], fontSize=10, leading=13)
    Small = ParagraphStyle("Small", parent=styles["BodyText"], fontSize=8, leading=10, textColor=colors.HexColor("#6B7280"))

    story: List = []

    stops = route.get("stops", [])
    delivered = [s for s in stops if s.get("status") == "delivered"]
    absent = [s for s in stops if s.get("status") == "absent"]
    pending = [s for s in stops if s.get("status") == "pending"]
    cod_collected = sum(float(s.get("cod_amount", 0) or 0) for s in delivered if s.get("is_cod") or (s.get("cod_amount") or 0) > 0)
    fees_collected = sum(float(s.get("extra_fees", 0) or 0) for s in delivered)
    total_money = round(cod_collected + fees_collected, 2)

    # Header
    story.append(Paragraph("GoPossible — Raport końca dnia", H1))
    story.append(Paragraph(
        f"<b>Trasa:</b> {route.get('name', '')}<br/>"
        f"<b>Kurier:</b> {courier_name or '—'}<br/>"
        f"<b>Wygenerowano:</b> {datetime.now().strftime('%d.%m.%Y %H:%M')}",
        Body,
    ))
    story.append(Spacer(1, 6))

    # Summary table
    summary_data = [
        ["DOSTARCZONE", "NIEOBECNI", "POZOSTAŁE", "PACZEK"],
        [str(len(delivered)), str(len(absent)), str(len(pending)), str(len(stops))],
    ]
    t = Table(summary_data, colWidths=[40 * mm] * 4)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F1F1F")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("FONTSIZE", (0, 1), (-1, 1), 18),
        ("FONTNAME", (0, 1), (-1, 1), "Helvetica-Bold"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.HexColor("#F9FAFB")]),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#E5E7EB")),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(t)
    story.append(Spacer(1, 6))

    # COD totals
    cod_box = [
        ["KWOTA DO ROZLICZENIA (PLN)", f"{total_money:.2f}"],
        ["w tym pobrania COD", f"{cod_collected:.2f}"],
        ["w tym opłaty dodatkowe", f"{fees_collected:.2f}"],
    ]
    tc = Table(cod_box, colWidths=[100 * mm, 60 * mm])
    tc.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E63329")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 11),
        ("FONTSIZE", (0, 1), (-1, -1), 9),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#E5E7EB")),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(tc)
    story.append(Spacer(1, 12))

    # Delivered list with thumbnails
    if delivered:
        story.append(Paragraph(f"DOSTARCZONE ({len(delivered)})", H2))
        for s in delivered:
            sig_img = _img_from_b64(s.get("signature_base64") or "", max_w=50 * mm, max_h=20 * mm)
            photo_img = _img_from_b64(s.get("photo_base64") or "", max_w=50 * mm, max_h=35 * mm)
            label = (
                f"<b>{s.get('order')}. {s.get('recipient_name') or '—'}</b><br/>"
                f"{s.get('address','')}<br/>"
                f"<font color='#6B7280' size='8'>"
                f"Paczki: {', '.join(s.get('package_numbers', []))}"
                + (f" • COD {s.get('cod_amount',0):.2f} PLN" if (s.get('cod_amount') or 0) > 0 else "")
                + (f" • Dostarczono: {(s.get('completed_at') or '')[:16].replace('T',' ')}" if s.get('completed_at') else "")
                + "</font>"
            )
            row = [[Paragraph(label, Body), photo_img or Paragraph("—", Small), sig_img or Paragraph("brak podpisu", Small)]]
            tr = Table(row, colWidths=[90 * mm, 45 * mm, 45 * mm])
            tr.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BOX", (0, 0), (-1, -1), 0.3, colors.HexColor("#E5E7EB")),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ]))
            story.append(tr)
            story.append(Spacer(1, 4))

    # Absent list
    if absent:
        story.append(PageBreak())
        story.append(Paragraph(f"NIEOBECNI ({len(absent)})", H2))
        rows = [["#", "Odbiorca", "Adres", "Notatka", "Czas"]]
        for s in absent:
            rows.append([
                str(s.get("order", "")),
                s.get("recipient_name") or "—",
                s.get("address", "") or "—",
                s.get("note") or "—",
                (s.get("completed_at") or "")[:16].replace("T", " "),
            ])
        ta = Table(rows, colWidths=[10 * mm, 45 * mm, 60 * mm, 45 * mm, 25 * mm])
        ta.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F1F1F")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#E5E7EB")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FFF7E6")]),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(ta)

    doc.build(story)
    return buf.getvalue()
