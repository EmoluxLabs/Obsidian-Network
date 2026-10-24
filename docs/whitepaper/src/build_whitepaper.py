#!/usr/bin/env python3
"""Builds docs/whitepaper/Obsidian-Network-White-Paper.pdf (reportlab).

Run from this directory:  python3 build_whitepaper.py
Needs: reportlab. Fonts: DejaVu (system). Every number below is taken from the protocol
parameters in obsidian-core/src/protocol/params.ts or from the reference documentation in docs/.
"""
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle,
                                PageBreak, KeepTogether, Image, NextPageTemplate, Preformatted, Flowable)
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.graphics.shapes import Drawing, Rect, String, Line, Polygon, Circle, PolyLine
from reportlab.platypus.flowables import HRFlowable, CondPageBreak

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'Obsidian-Network-White-Paper.pdf')
LOGO = os.path.join(HERE, '..', 'assets', 'obs-coin-logo.png')
FD = '/usr/share/fonts/truetype/dejavu/'
for n, f in [('Sans', 'DejaVuSans.ttf'), ('Sans-B', 'DejaVuSans-Bold.ttf'), ('Mono', 'DejaVuSansMono.ttf'),
             ('Mono-B', 'DejaVuSansMono-Bold.ttf'), ('Serif', 'DejaVuSerif.ttf'), ('Serif-B', 'DejaVuSerif-Bold.ttf')]:
    pdfmetrics.registerFont(TTFont(n, FD + f))
from reportlab.pdfbase.pdfmetrics import registerFontFamily
registerFontFamily('Sans', normal='Sans', bold='Sans-B', italic='Sans', boldItalic='Sans-B')
registerFontFamily('Mono', normal='Mono', bold='Mono-B', italic='Mono', boldItalic='Mono-B')
registerFontFamily('Serif', normal='Serif', bold='Serif-B', italic='Serif', boldItalic='Serif-B')

# ── palette: light page, obsidian-black ink, silver rules, one steel accent ──
INK = colors.HexColor('#14171c')
BODY = colors.HexColor('#2a2f37')
MUTED = colors.HexColor('#6b727c')
SILVER = colors.HexColor('#c4c9d0')
PALE = colors.HexColor('#f3f4f6')
PALE2 = colors.HexColor('#e8eaee')
ACCENT = colors.HexColor('#2c4a68')
ACCENT_L = colors.HexColor('#e6edf4')
LINK = '#1d4f8c'

W, H = A4
LM = RM = 22 * mm
TM = 24 * mm
BM = 21 * mm
CW = W - LM - RM

S = {}
S['body'] = ParagraphStyle('body', fontName='Sans', fontSize=9.2, leading=14.2, textColor=BODY, spaceAfter=6.2, alignment=TA_LEFT)
S['lead'] = ParagraphStyle('lead', parent=S['body'], fontSize=10.4, leading=16, textColor=INK, spaceAfter=8)
S['h1'] = ParagraphStyle('h1', fontName='Sans-B', fontSize=20, leading=25, textColor=INK, spaceBefore=0, spaceAfter=4)
S['h2'] = ParagraphStyle('h2', fontName='Sans-B', fontSize=12.2, leading=16, textColor=ACCENT, spaceBefore=11, spaceAfter=4)
S['h3'] = ParagraphStyle('h3', fontName='Sans-B', fontSize=9.8, leading=13, textColor=INK, spaceBefore=7, spaceAfter=2.5)
S['kicker'] = ParagraphStyle('kicker', fontName='Sans-B', fontSize=8, leading=10, textColor=MUTED, spaceAfter=2)
S['bullet'] = ParagraphStyle('bullet', parent=S['body'], leftIndent=13, bulletIndent=2, spaceAfter=3.2)
S['cell'] = ParagraphStyle('cell', fontName='Sans', fontSize=8.2, leading=11.2, textColor=BODY)
S['cellb'] = ParagraphStyle('cellb', parent=S['cell'], fontName='Sans-B', textColor=INK)
S['cellh'] = ParagraphStyle('cellh', parent=S['cell'], fontName='Sans-B', textColor=colors.white)
S['mono'] = ParagraphStyle('mono', fontName='Mono', fontSize=7.8, leading=10.6, textColor=INK)
S['cap'] = ParagraphStyle('cap', fontName='Sans', fontSize=8, leading=11, textColor=MUTED, spaceBefore=3, spaceAfter=10)
S['callh'] = ParagraphStyle('callh', fontName='Sans-B', fontSize=8.4, leading=11, textColor=ACCENT, spaceAfter=2)
S['calls'] = ParagraphStyle('calls', parent=S['body'], fontSize=8.8, leading=13.2, spaceAfter=0)
S['toc0'] = ParagraphStyle('toc0', fontName='Sans-B', fontSize=9.6, leading=17, textColor=INK, leftIndent=0)
S['toc1'] = ParagraphStyle('toc1', fontName='Sans', fontSize=8.6, leading=13, textColor=BODY, leftIndent=14)


def esc(t):
    return t


def P(t, st='body'):
    return Paragraph(t, S[st])


def B(items):
    return [Paragraph(t, S['bullet'], bulletText='•') for t in items]


def link(url, label=None):
    return f'<a href="{url}" color="{LINK}">{label or url}</a>'


class Heading(Paragraph):
    """Paragraph that registers itself in the table of contents and the PDF outline."""

    def __init__(self, text, style, level):
        super().__init__(text, style)
        self.level = level
        self.plain = text


def H1(t):
    return Heading(t, S['h1'], 0)


def H2(t):
    return Heading(t, S['h2'], 1)


def H3(t):
    return P(t, 'h3')


def rule():
    return HRFlowable(width='100%', thickness=0.8, color=SILVER, spaceBefore=0, spaceAfter=10)


def table(rows, widths, header=True, zebra=True, mono_cols=(), bold_first=False, fs=None, pad=(4.2, 4.6)):
    data = []
    for ri, r in enumerate(rows):
        row = []
        for ci, c in enumerate(r):
            if isinstance(c, Flowable) or isinstance(c, list):
                row.append(c)
                continue
            if header and ri == 0:
                row.append(Paragraph(c, S['cellh']))
            else:
                st = S['cellb'] if (bold_first and ci == 0) else S['cell']
                if ci in mono_cols:
                    st = ParagraphStyle('m', parent=S['cell'], fontName='Mono', fontSize=7.6, leading=10.6, textColor=INK)
                row.append(Paragraph(c, st))
        data.append(row)
    tot = sum(widths)
    cw = [w / tot * CW for w in widths]
    t = Table(data, colWidths=cw, repeatRows=1 if header else 0)
    ts = [('VALIGN', (0, 0), (-1, -1), 'TOP'),
          ('LEFTPADDING', (0, 0), (-1, -1), 6), ('RIGHTPADDING', (0, 0), (-1, -1), 6),
          ('TOPPADDING', (0, 0), (-1, -1), pad[0]), ('BOTTOMPADDING', (0, 0), (-1, -1), pad[1]),
          ('LINEBELOW', (0, 0), (-1, -1), 0.4, PALE2),
          ('BOX', (0, 0), (-1, -1), 0.6, SILVER)]
    if header:
        ts += [('BACKGROUND', (0, 0), (-1, 0), INK)]
    if zebra:
        for i in range(1 if header else 0, len(rows)):
            if (i % 2) == 0:
                ts.append(('BACKGROUND', (0, i), (-1, i), PALE))
    t.setStyle(TableStyle(ts))
    return t


def callout(title, text):
    inner = [Paragraph(title, S['callh']), Paragraph(text, S['calls'])]
    t = Table([[inner]], colWidths=[CW])
    t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), ACCENT_L), ('LINEBEFORE', (0, 0), (0, -1), 3, ACCENT),
                           ('LEFTPADDING', (0, 0), (-1, -1), 11), ('RIGHTPADDING', (0, 0), (-1, -1), 10),
                           ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 8)]))
    return KeepTogether([t, Spacer(1, 8)])


def code(text, label=None):
    pre = Preformatted(text, S['mono'])
    t = Table([[pre]], colWidths=[CW])
    t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), PALE), ('BOX', (0, 0), (-1, -1), 0.5, SILVER),
                           ('LEFTPADDING', (0, 0), (-1, -1), 9), ('TOPPADDING', (0, 0), (-1, -1), 6),
                           ('BOTTOMPADDING', (0, 0), (-1, -1), 7)]))
    parts = []
    if label:
        parts.append(Paragraph(label, S['kicker']))
    parts += [t, Spacer(1, 8)]
    k = KeepTogether(parts)
    k._iscode = True
    return k


def kt(*fl):
    return KeepTogether(list(fl))


def figure(drawing, caption):
    return KeepTogether([drawing, Paragraph(caption, S['cap'])])


# ───────────────────────── figures ─────────────────────────
def box(d, x, y, w, h, title, sub=None, fill=PALE, stroke=SILVER, tc=INK, bold=True, fs=8):
    d.add(Rect(x, y, w, h, rx=4, ry=4, fillColor=fill, strokeColor=stroke, strokeWidth=0.8))
    if sub:
        d.add(String(x + w / 2, y + h / 2 + 2.5, title, fontName='Sans-B' if bold else 'Sans', fontSize=fs, fillColor=tc, textAnchor='middle'))
        d.add(String(x + w / 2, y + h / 2 - 8.5, sub, fontName='Sans', fontSize=6.6, fillColor=MUTED, textAnchor='middle'))
    else:
        d.add(String(x + w / 2, y + h / 2 - 3, title, fontName='Sans-B' if bold else 'Sans', fontSize=fs, fillColor=tc, textAnchor='middle'))


def arrow(d, x1, y1, x2, y2, col=MUTED):
    d.add(Line(x1, y1, x2, y2, strokeColor=col, strokeWidth=0.9))
    import math
    a = math.atan2(y2 - y1, x2 - x1)
    s = 4.2
    p = [x2, y2, x2 - s * math.cos(a - 0.45), y2 - s * math.sin(a - 0.45), x2 - s * math.cos(a + 0.45), y2 - s * math.sin(a + 0.45)]
    d.add(Polygon(p, fillColor=col, strokeColor=col, strokeWidth=0.2))


def fig_architecture():
    d = Drawing(CW, 232)
    # chain layer
    d.add(Rect(0, 150, CW, 78, rx=5, ry=5, fillColor=INK, strokeColor=INK))
    d.add(String(12, 214, 'OBSIDIAN CORE  ·  the chain', fontName='Sans-B', fontSize=8.5, fillColor=colors.white))
    items = ['Consensus', 'State machine', 'P2P network', 'Mempool', 'Indexer', 'Node RPC']
    bw = (CW - 24 - 5 * 6) / 6
    for i, t in enumerate(items):
        x = 12 + i * (bw + 6)
        d.add(Rect(x, 160, bw, 38, rx=3, ry=3, fillColor=colors.HexColor('#262b33'), strokeColor=colors.HexColor('#4a525d'), strokeWidth=0.6))
        d.add(String(x + bw / 2, 175, t, fontName='Sans', fontSize=7.2, fillColor=colors.white, textAnchor='middle'))
    # connector
    d.add(String(CW / 2, 133, 'every product reads the chain through the same node RPC', fontName='Sans', fontSize=7, fillColor=MUTED, textAnchor='middle'))
    for x in [CW * (i + 0.5) / 5 for i in range(5)]:
        arrow(d, x, 126, x, 150, MUTED)
        d.add(Line(x, 126, x, 118, strokeColor=MUTED, strokeWidth=0.9))
    names = [('Platform', 'mineobs.network'), ('Web App', 'app.mineobs.network'), ('Wallet', 'wallet.mineobs.network'),
             ('Extension', 'Chrome · Edge · Firefox'), ('Obsidian Node', 'desktop operator app')]
    w5 = (CW - 4 * 8) / 5
    for i, (a, b) in enumerate(names):
        x = i * (w5 + 8)
        box(d, x, 64, w5, 52, a, b, fill=colors.white, stroke=ACCENT, tc=ACCENT, fs=8.4)
    d.add(Rect(0, 8, CW, 44, rx=4, ry=4, fillColor=PALE, strokeColor=SILVER, strokeWidth=0.7))
    d.add(String(CW / 2, 33, 'Source of truth', fontName='Sans-B', fontSize=7.6, fillColor=INK, textAnchor='middle'))
    d.add(String(CW / 2, 19, 'consensus  →  node state  →  verified chain data  →  APIs and indexes  →  frontend cache',
                 fontName='Sans', fontSize=7.6, fillColor=BODY, textAnchor='middle'))
    return d


def fig_schedule():
    d = Drawing(CW, 138)
    n = 6
    d.add(String(0, 124, 'Producer set, sorted by producer address   ·   producer(height, round) = set[(height + round) mod n]', fontName='Sans-B', fontSize=7.4, fillColor=INK))
    sw = CW / 9
    labels = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6']
    for i in range(9):
        x = i * sw
        nd = (i + 0) % n
        miss = (i == 3)
        d.add(Rect(x + 2, 62, sw - 4, 44, rx=3, ry=3, fillColor=(colors.HexColor('#fbe9e7') if miss else PALE), strokeColor=(colors.HexColor('#c0564b') if miss else SILVER), strokeWidth=0.8))
        d.add(String(x + sw / 2, 88, f'slot {i + 1}', fontName='Sans', fontSize=6.6, fillColor=MUTED, textAnchor='middle'))
        if miss:
            d.add(String(x + sw / 2, 72, 'N4 silent', fontName='Sans-B', fontSize=7.2, fillColor=colors.HexColor('#9b3a30'), textAnchor='middle'))
        else:
            nm = labels[nd if i < 3 else (nd - 1) % n] if i != 3 else 'N4'
            d.add(String(x + sw / 2, 72, 'N%d block' % ((i if i < 3 else i - 1) % n + 1), fontName='Sans-B', fontSize=7.2, fillColor=INK, textAnchor='middle'))
    arrow(d, 0, 52, CW, 52, MUTED)
    d.add(String(0, 40, 'protocol time  (one slot = 5 seconds)', fontName='Sans', fontSize=6.8, fillColor=MUTED))
    d.add(String(CW, 40, 'a silent producer costs one slot, never the chain', fontName='Sans', fontSize=6.8, fillColor=MUTED, textAnchor='end'))
    d.add(String(0, 22, 'After a skipped slot the turn passes to the next node in the set. Three consecutive misses suspend a node for 10 minutes,', fontName='Sans', fontSize=6.8, fillColor=BODY))
    d.add(String(0, 11, 'doubling on each repeat up to 24 hours. Suspension costs turns and reward weight; no funds are ever confiscated.', fontName='Sans', fontSize=6.8, fillColor=BODY))
    return d


def fig_reward_curve():
    pts = [(0, 1.0), (1, 0.951110), (5, 0.778313), (10, 0.605770), (15, 0.4697), (20, 0.366958), (25, 0.2858), (30, 0.2217), (32.2, 0.2), (36, 0.2)]
    # exact points from the schedule rule  daily = 0.001 * 0.995^floor(m/100000), floor 0.0002
    import math
    pts = []
    for m in [x * 0.5 for x in range(0, 73)]:
        steps = int(m * 1e6 // 100000)
        v = 0.001 * (0.995 ** steps)
        pts.append((m, max(v, 0.0002) * 1000))
    d = Drawing(CW, 190)
    x0, y0, pw, ph = 46, 34, CW - 62, 128
    d.add(Rect(x0, y0, pw, ph, fillColor=colors.white, strokeColor=SILVER, strokeWidth=0.7))
    for k in range(0, 6):
        yv = 0.2 + k * 0.16
        y = y0 + (yv - 0.1) / (1.1 - 0.1) * ph
        d.add(Line(x0, y, x0 + pw, y, strokeColor=PALE2, strokeWidth=0.5))
        d.add(String(x0 - 5, y - 2.5, f'{yv * 0.001:.5f}'.rstrip('0'), fontName='Sans', fontSize=6.4, fillColor=MUTED, textAnchor='end'))
    for k in range(0, 8):
        mv = k * 5
        x = x0 + mv / 36 * pw
        d.add(Line(x, y0, x, y0 - 3, strokeColor=MUTED, strokeWidth=0.6))
        d.add(String(x, y0 - 12, f'{mv}M', fontName='Sans', fontSize=6.4, fillColor=MUTED, textAnchor='middle'))
    line = []
    for m, v in pts:
        line += [x0 + m / 36 * pw, y0 + (v - 0.1 * 1000 / 1000 * 1.0 - 0.0) / 1.0 * 0 + ((v / 1.0) - 0.1) / (1.1 - 0.1) * ph * 1.0]
    # v is already scaled so 1.0 == 0.001 OBS
    line = []
    for m, v in pts:
        line += [x0 + m / 36 * pw, y0 + (v - 0.1) / (1.1 - 0.1) * ph]
    d.add(PolyLine(line, strokeColor=ACCENT, strokeWidth=1.8))
    fx = x0 + 32.2 / 36 * pw
    fy = y0 + (0.2 - 0.1) / 1.0 * ph
    d.add(Circle(fx, fy, 2.6, fillColor=INK, strokeColor=INK))
    d.add(String(x0 + pw - 4, fy + 22, 'floor reached at 32.2M active miners', fontName='Sans', fontSize=6.8, fillColor=INK, textAnchor='end'))
    d.add(Line(fx, fy + 3, fx, fy + 19, strokeColor=MUTED, strokeWidth=0.5))
    d.add(Circle(x0, y0 + (1.0 - 0.1) / 1.0 * ph, 2.6, fillColor=INK, strokeColor=INK))
    d.add(String(x0 + 7, y0 + (1.0 - 0.1) / 1.0 * ph - 2.5, 'genesis participation: 0.001 OBS / day', fontName='Sans', fontSize=6.8, fillColor=INK))
    d.add(String(x0 + pw / 2, 7, 'active miners (wallets with a valid claim in the last 30 days)', fontName='Sans', fontSize=7, fillColor=MUTED, textAnchor='middle'))
    d.add(String(0, y0 + ph + 12, 'OBS per wallet per day (six claims)', fontName='Sans', fontSize=7, fillColor=MUTED))
    return d


def fig_value_flows():
    d = Drawing(CW, 214)
    cw_ = CW
    # row 1: gas → mining pool → mining rewards
    d.add(String(0, 200, 'A  ·  Gas and mining rewards', fontName='Sans-B', fontSize=7.8, fillColor=ACCENT))
    box(d, 0, 150, 120, 36, 'Value-bearing transaction', 'sender pays amount + gas', fill=colors.white)
    box(d, 168, 150, 110, 36, 'Mining Pool', 'protocol state', fill=ACCENT_L, stroke=ACCENT, tc=ACCENT)
    box(d, 326, 150, cw_ - 326, 36, 'Mining claim reward', 'pool is spent first, then new issue', fill=colors.white)
    arrow(d, 120, 168, 168, 168)
    d.add(String(144, 173, 'gas', fontName='Sans', fontSize=6.6, fillColor=MUTED, textAnchor='middle'))
    arrow(d, 278, 168, 326, 168)
    d.add(String(302, 173, 'funds', fontName='Sans', fontSize=6.6, fillColor=MUTED, textAnchor='middle'))
    # row 2: ONS revenue split
    d.add(String(0, 124, 'B  ·  ONS revenue (the protocol\'s only revenue source)', fontName='Sans-B', fontSize=7.8, fillColor=ACCENT))
    box(d, 0, 66, 120, 40, '.obs name fee', 'registration or renewal, 0.05 OBS', fill=colors.white)
    box(d, 170, 88, 190, 34, 'Node Runner Reward Pool', '90%  ·  settled once per 24-hour period', fill=ACCENT_L, stroke=ACCENT, tc=ACCENT)
    box(d, 170, 46, 190, 34, 'Treasury wallet', '10%  ·  same block as the fee', fill=colors.white)
    arrow(d, 120, 90, 170, 105)
    arrow(d, 120, 82, 170, 63)
    box(d, 392, 88, cw_ - 392, 34, 'Node runners', 'by recorded score', fill=colors.white)
    arrow(d, 360, 105, 392, 105)
    # row 3: marketplace
    d.add(String(0, 24, 'C  ·  ONS Marketplace: the seller receives exactly the price; there is no commission. Gas goes to the Mining Pool.', fontName='Sans-B', fontSize=7.4, fillColor=ACCENT))
    d.add(String(0, 10, 'Offers lock the offered OBS in consensus escrow until the owner accepts or declines, or the offer lapses after 7 days.', fontName='Sans', fontSize=6.8, fillColor=BODY))
    return d


def fig_name_lifecycle():
    d = Drawing(CW, 118)
    segs = [('Available', 0.16, colors.white, INK, 'open to all'),
            ('Active  ·  365 days', 0.42, ACCENT_L, ACCENT, 'resolve · renew · transfer · list'),
            ('Grace  ·  30 days', 0.26, PALE2, INK, 'only the owner can renew'),
            ('Available', 0.16, colors.white, INK, 'back in the pool')]
    x = 0
    for t, f, fill, tc, sub in segs:
        w = CW * f
        d.add(Rect(x, 52, w - 3, 40, rx=3, ry=3, fillColor=fill, strokeColor=SILVER, strokeWidth=0.8))
        d.add(String(x + (w - 3) / 2, 75, t, fontName='Sans-B', fontSize=7.6, fillColor=tc, textAnchor='middle'))
        d.add(String(x + (w - 3) / 2, 62, sub, fontName='Sans', fontSize=6.2, fillColor=MUTED, textAnchor='middle'))
        x += w
    arrow(d, 0, 40, CW, 40)
    d.add(String(CW * 0.16, 28, 'registered', fontName='Sans', fontSize=6.6, fillColor=MUTED, textAnchor='middle'))
    d.add(String(CW * 0.58, 28, 'expires', fontName='Sans', fontSize=6.6, fillColor=MUTED, textAnchor='middle'))
    d.add(String(CW * 0.84, 28, 'grace ends', fontName='Sans', fontSize=6.6, fillColor=MUTED, textAnchor='middle'))
    d.add(String(0, 8, 'A fee of 0.05 OBS buys or renews one year. Names are 3 to 63 characters. A name inside its grace period cannot be registered by anyone else.', fontName='Sans', fontSize=6.8, fillColor=BODY))
    return d


def fig_claim_flow():
    d = Drawing(CW, 96)
    steps = [('1  Sign in', 'MFA account'), ('2  Wallet', 'one per account'), ('3  Ask node', 'eligible now?'),
             ('4  Certificate', 'one claim only'), ('5  Sign, submit', 'in the browser'), ('6  Block', 'reward credited')]
    n = len(steps)
    gap = 9
    w = (CW - gap * (n - 1)) / n
    for i, (a, b) in enumerate(steps):
        x = i * (w + gap)
        box(d, x, 40, w, 42, a, b, fill=(ACCENT_L if i in (2, 5) else colors.white), stroke=ACCENT if i in (2, 5) else SILVER, tc=INK, fs=6.8)
        if i < n - 1:
            arrow(d, x + w, 61, x + w + gap, 61)
    d.add(String(0, 20, 'The chain, not the interface, decides eligibility and timing from the wallet\'s own claim history and the block time.', fontName='Sans', fontSize=6.9, fillColor=BODY))
    d.add(String(0, 9, 'A claim is a signed MINING_CLAIM transaction. The device clock is never consulted.', fontName='Sans', fontSize=6.9, fillColor=BODY))
    return d


# ───────────────────────── document ─────────────────────────
class Doc(BaseDocTemplate):
    def __init__(self, fn, **kw):
        super().__init__(fn, pagesize=A4, leftMargin=LM, rightMargin=RM, topMargin=TM, bottomMargin=BM,
                         title='Obsidian Network: White Paper', author='Obsidian Network',
                         subject='The Proof of Time Blockchain: Obsidian Seal Coin (OBS)', **kw)
        fr = Frame(LM, BM, CW, H - TM - BM, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0, id='f')
        self.addPageTemplates([PageTemplate(id='cover', frames=[Frame(0, 0, W, H, 0, 0, 0, 0)], onPage=self.cover_page),
                               PageTemplate(id='body', frames=[fr], onPage=self.body_page)])
        self._k = 0

    def cover_page(self, c, d):
        c.saveState()
        c.setFillColor(INK)
        c.rect(0, H - 14 * mm, W, 14 * mm, fill=1, stroke=0)
        c.setFillColor(SILVER)
        c.rect(0, H - 14.8 * mm, W, 0.8 * mm, fill=1, stroke=0)
        c.setFillColor(colors.white)
        c.setFont('Sans-B', 8)
        c.drawString(LM, H - 9 * mm, 'OBSIDIAN NETWORK')
        c.setFont('Sans', 8)
        c.drawRightString(W - RM, H - 9 * mm, 'WHITE PAPER  ·  VERSION 1.1')
        # logo
        s = 62 * mm
        c.drawImage(LOGO, (W - s) / 2, H - 14.8 * mm - 20 * mm - s, s, s, mask='auto', preserveAspectRatio=True)
        y = H - 14.8 * mm - 20 * mm - s - 16 * mm
        c.setFillColor(INK)
        c.setFont('Sans-B', 30)
        c.drawCentredString(W / 2, y, 'OBSIDIAN NETWORK')
        c.setFont('Sans', 13)
        c.setFillColor(ACCENT)
        c.drawCentredString(W / 2, y - 9 * mm, 'The Proof of Time Blockchain')
        c.setStrokeColor(SILVER)
        c.setLineWidth(0.8)
        c.line(W / 2 - 30 * mm, y - 15 * mm, W / 2 + 30 * mm, y - 15 * mm)
        c.setFillColor(INK)
        c.setFont('Sans-B', 15)
        c.drawCentredString(W / 2, y - 25 * mm, 'White Paper')
        c.setFillColor(BODY)
        c.setFont('Sans', 9.6)
        c.drawCentredString(W / 2, y - 32.5 * mm, 'Obsidian Seal Coin (OBS)  ·  Mainnet  ·  Chain ID 7777')
        c.drawCentredString(W / 2, y - 38.5 * mm, 'The ledger, its consensus, its economy and the products built on it')
        # meta panel
        py = 38 * mm
        c.setFillColor(PALE)
        c.roundRect(LM, py, CW, 31 * mm, 3, fill=1, stroke=0)
        c.setFillColor(INK)
        c.setFont('Sans-B', 7.6)
        cols = [('DOCUMENT', 'White Paper, version 1.1'), ('RELEASE', 'Obsidian Core 2.0.4 · Protocol 2.0.2'),
                ('DATE', '24 October 2026'), ('PUBLISHER', 'Emolux Labs')]
        cx = LM + 8 * mm
        for i, (k, v) in enumerate(cols):
            xx = LM + 8 * mm + (i % 2) * (CW / 2)
            yy = py + 31 * mm - 9 * mm - (i // 2) * 11 * mm
            c.setFillColor(MUTED)
            c.setFont('Sans-B', 6.8)
            c.drawString(xx, yy, k)
            c.setFillColor(INK)
            c.setFont('Sans', 9)
            c.drawString(xx, yy - 4.6 * mm, v)
        # links
        c.setFont('Sans', 8.4)
        c.setFillColor(ACCENT)
        lx = [('mineobs.network', 'https://mineobs.network'), ('app.mineobs.network', 'https://app.mineobs.network'),
              ('wallet.mineobs.network', 'https://wallet.mineobs.network'), ('api.mineobs.network', 'https://api.mineobs.network')]
        total = sum(pdfmetrics.stringWidth(t, 'Sans', 8.4) for t, _ in lx) + 3 * 10 * mm
        x = (W - total) / 2
        for t, u in lx:
            wv = pdfmetrics.stringWidth(t, 'Sans', 8.4)
            c.drawString(x, 26 * mm, t)
            c.linkURL(u, (x, 26 * mm - 2, x + wv, 26 * mm + 9), relative=0)
            x += wv + 10 * mm
        c.setFillColor(MUTED)
        c.setFont('Sans', 7.4)
        c.drawCentredString(W / 2, 17 * mm, 'Public Technical Documentation  ·  emoluxlabs@gmail.com  ·  github.com/EmoluxLabs/Obsidian-Network')
        c.restoreState()

    def body_page(self, c, d):
        c.saveState()
        c.setStrokeColor(SILVER)
        c.setLineWidth(0.6)
        c.line(LM, H - 15 * mm, W - RM, H - 15 * mm)
        c.drawImage(LOGO, LM, H - 13.2 * mm, 7.4 * mm, 7.4 * mm, mask='auto', preserveAspectRatio=True)
        c.setFillColor(INK)
        c.setFont('Sans-B', 7.6)
        c.drawString(LM + 9.6 * mm, H - 10.4 * mm, 'OBSIDIAN NETWORK')
        c.setFillColor(MUTED)
        c.setFont('Sans', 7.4)
        c.drawRightString(W - RM, H - 10.4 * mm, 'White Paper  ·  The Proof of Time Blockchain')
        c.setStrokeColor(SILVER)
        c.line(LM, 15 * mm, W - RM, 15 * mm)
        c.setFont('Sans', 7.2)
        c.drawString(LM, 10.4 * mm, 'Public Technical Documentation  ·  Version 1.1  ·  Core 2.0.4  ·  Protocol 2.0.2')
        c.setFillColor(INK)
        c.setFont('Sans-B', 7.8)
        c.drawRightString(W - RM, 10.4 * mm, 'Page %d' % (d.page))
        c.restoreState()

    def afterFlowable(self, f):
        if isinstance(f, Heading):
            import hashlib
            key = 'h' + hashlib.md5(f.plain.encode()).hexdigest()[:10]
            self.canv.bookmarkPage(key)
            import re
            txt = re.sub('<[^>]+>', '', f.plain)
            self.canv.addOutlineEntry(txt, key, level=f.level, closed=(f.level > 0))
            self.notify('TOCEntry', (f.level, f.plain, self.page, key))


def section(title, kicker=None):
    out = [PageBreak()]
    if kicker:
        out.append(P(kicker.upper(), 'kicker'))
    out += [H1(title), rule()]
    return out


# ───────────────────────── content ─────────────────────────
def build():
    st = []
    st.append(NextPageTemplate('body'))
    st.append(PageBreak())

    # contents
    st.append(P('CONTENTS', 'kicker'))
    st.append(Paragraph('Contents', S['h1']))
    st.append(rule())
    toc = TableOfContents()
    toc.levelStyles = [S['toc0'], S['toc1']]
    toc.dotsMinLevel = 0
    st.append(toc)

    # 1 ─ abstract
    st += section('1  Abstract', 'Overview')
    st.append(P('Obsidian Network is a Proof of Time blockchain with a fixed maximum supply of <b>21,000,000 OBS</b>. Its native coin, '
                'Obsidian Seal Coin (ticker <b>OBS</b>), moves on a public ledger that anyone can read, verify and run. Mainnet is live on '
                'chain ID <b>7777</b> with the address prefix <b>obs</b>.', 'lead'))
    st.append(P('The network is built for ordinary people, most of them on a phone. A person creates a wallet in the browser, claims a small '
                'protocol-defined reward every four hours, sends and receives OBS, registers a human-readable <b>.obs</b> name, trades names '
                'on a built-in marketplace, and can run a node that is paid from the protocol\'s only revenue stream. Each of those actions is '
                'chain state: it is recomputed by every node and rejected if it breaks a rule. None of it lives in a company database.'))
    st.append(P('Consensus is <b>Proof of Time</b>. The right to produce a block comes from a deterministic schedule over registered, live '
                'nodes and from the chain\'s own clock, not from a race of computation. There is no hash puzzle, no block nonce, and no '
                'advantage in computing faster. Hashing and signatures protect integrity and identity; time is what orders the chain.'))
    st.append(P('This paper describes the network and every product in the Obsidian ecosystem as they exist today: the ledger and its '
                'rules, the mining and reward economy, the Obsidian Name Service and its Marketplace, node-runner rewards, and the five '
                'ways people use the network: the Platform, the Web App, the Wallet, the browser Extension and the Obsidian Node desktop application.'))
    st.append(Spacer(1, 4))
    st.append(table([
        ['At a glance', ''],
        ['Network', 'Obsidian Network  ·  <b>Mainnet is live</b>'],
        ['Coin', 'Obsidian Seal Coin (OBS), a native coin of its own chain'],
        ['Consensus', 'Proof of Time: deterministic producer schedule gated by protocol time'],
        ['Maximum supply', '21,000,000 OBS, enforced on every issuance'],
        ['Block time', '5 seconds (target)'],
        ['Chain ID / address prefix', '7777  /  <font name="Mono">obs1…</font>'],
        ['Issuance', 'Mining claims, plus a one-time 100,000 OBS genesis allocation. No other path exists.'],
        ['Fees', 'Gas of 0.02% of the amount (maximum 0.01 OBS) to the Mining Pool; 0.05 OBS for a .obs name'],
        ['Revenue', 'ONS fees only: 90% to the Node Runner Reward Pool, 10% to the treasury wallet'],
        ['Release', 'Obsidian Core 2.0.4, protocol 2.0.2, open source under Apache-2.0'],
        ['Official links', link('https://mineobs.network', 'mineobs.network') + '  ·  ' + link('https://app.mineobs.network', 'app.mineobs.network') + '  ·  ' + link('https://wallet.mineobs.network', 'wallet.mineobs.network') + '  ·  ' + link('https://api.mineobs.network', 'api.mineobs.network')],
        ['Genesis id and live network details', 'Visit the main web page at ' + link('https://mineobs.network')],
    ], [1.1, 3.2], bold_first=True))

    # 2 ─ introduction
    st += section('2  Introduction', 'Why Obsidian exists')
    st.append(P('Most blockchains ask a participant to commit capital or machinery. Obsidian asks for something every person already has: '
                'time. The core activity on the network is a claim a person makes from a phone every four hours, six times a day. '
                'That design has exactly one hard problem, which is deciding <b>what time it is without letting the participant decide</b>.', 'lead'))
    st.append(P('Proof of Work sidesteps the problem by making block production expensive. Obsidian solves it directly. The chain carries its own '
                'clock, derived from block timestamps, and every rule that matters (claim windows, name expiry, reward periods and '
                'transaction expiry) is evaluated against that clock. A participant\'s device clock, a website\'s clock, a CDN\'s clock '
                'and a node operator\'s clock cannot move it.'))
    st.append(H2('2.1  Design principles'))
    st += B([
        '<b>The chain is the source of truth.</b> Names, balances, claims and node registrations are ledger state. Websites, caches and databases only display it.',
        '<b>Users hold their keys.</b> Wallet keys are created in the user\'s browser or device and are never transmitted. Nodes see only public addresses and finished, signed transactions.',
        '<b>One network, one set of rules.</b> Every product reaches the chain through the same node RPC and builds transactions with the same encoder the node uses.',
        '<b>Prices belong to the protocol.</b> Every fee is denominated in OBS and fixed by consensus. No external price feed can change what anything costs.',
        '<b>Participation is open and measured, not self-reported.</b> A node is rewarded for uptime and behaviour that other nodes attested; there is no field in which a node reports its own performance.',
        '<b>Determinism everywhere.</b> Reward amounts, schedules, splits and eligibility are exact integer computations that every node reproduces identically.',
    ])
    st.append(H2('2.2  What makes Obsidian different'))
    st.append(table([
        ['Property', 'Obsidian Network'],
        ['Right to produce a block', 'The deterministic producer schedule, once protocol time has advanced. Not computation spent in a race.'],
        ['Headline network metric', 'Time-Rate: verified blocks and transactions per minute of protocol time'],
        ['Entry cost to run a node', 'None. Registration needs no gas, no deposit and no wallet signature.'],
        ['Mining', 'A signed claim that the protocol clock permits: one every four hours, six per day, per wallet'],
        ['Names', 'A .obs name maps to one wallet address as consensus state, with transfer, recovery and a marketplace'],
        ['Application data', 'First-class chain state: names, claims, listings, escrow and the node registry'],
        ['Native coin', 'OBS is the native coin of the Obsidian chain. It is not a token on another blockchain.'],
    ], [1.2, 3.2], bold_first=True))

    # 3 ─ architecture
    st += section('3  System architecture', 'The network and its products')
    st.append(P('Obsidian is a family of products around one chain. The node is the reference implementation of the protocol; every '
                'other product is a client of its RPC. None of them is a second blockchain, and none holds keys or balances on the user\'s behalf.', 'lead'))
    st.append(figure(fig_architecture(), 'Figure 1. Every Obsidian product reads and writes the chain through the same node RPC.'))
    st.append(table([
        ['Component', 'Role'],
        ['Obsidian Core', 'The node. Validates and serves the chain: block production, peer-to-peer networking, mempool, RPC (default port 8630 on mainnet), indexer and the state machine.'],
        ['Platform (mineobs.network)', 'The account system and the public sites: Mine OBS, Wallet, Explorer, ONS and Marketplace, Node Runners, Developer.'],
        ['Web App (app.mineobs.network)', 'The Obsidian client in the browser: account, mining, wallet, explorer, names and an API console. Shares accounts with the Platform.'],
        ['Wallet (wallet.mineobs.network)', 'A non-custodial browser wallet: create or import, receive, send, activity, encrypted backup.'],
        ['Browser Extension', 'The Obsidian client as a Manifest V3 extension for Chrome, Edge and Firefox, with claim alerts.'],
        ['Obsidian Node', 'The desktop application (Windows, macOS, Linux) that runs a real node with a local operator dashboard.'],
        ['Edge layer', 'A Cloudflare worker that caches and forwards read traffic. It signs nothing and decides nothing.'],
    ], [1.15, 3.4], bold_first=True))
    parts31 = [H2('3.1  The four networks')]
    parts31.append(P('Obsidian runs four isolated networks from one codebase. Mainnet carries real value; the others exist for rehearsal and development.'))
    parts31.append(table([
        ['Network', 'Chain ID', 'Address prefix', 'RPC / P2P port', 'Purpose'],
        ['<b>mainnet</b>', '7777', '<font name="Mono">obs1…</font>', '8630 / 8631', 'The live network and real value'],
        ['testnet', '7778', '<font name="Mono">tobs1…</font>', '18630 / 18631', 'Public rehearsal'],
        ['staging', '7779', '<font name="Mono">sobs1…</font>', '28630 / 28631', 'Release candidates'],
        ['devnet', '7780', '<font name="Mono">dobs1…</font>', '38630 / 38631', 'Local development'],
    ], [1, 0.8, 1.1, 1.2, 1.9]))
    st.append(KeepTogether(parts31))
    st.append(P('Networks are separated by genesis document, genesis id, hash, parameters hash and chain ID. A node rejects a block, '
                'transaction or peer from another network and refuses to start on a data directory written by a different one. Address '
                'prefixes differ on every network, so a mainnet address cannot be mistyped into a test-network transaction.'))
    st.append(H2('3.2  Official links'))
    st.append(P('These are the official addresses of Obsidian Network. Use only these to reach the network\'s products.'))
    st.append(table([
        ['Product', 'Official address', 'Purpose'],
        ['Main web page', link('https://mineobs.network'), 'The home of the network: Mine OBS, wallet, explorer, ONS and Marketplace, node runners, developer resources and the account system'],
        ['Web App', link('https://app.mineobs.network'), 'The full Obsidian client in a browser or on a phone'],
        ['Wallet web app', link('https://wallet.mineobs.network'), 'The non-custodial browser wallet'],
        ['API', link('https://api.mineobs.network'), 'The official network API'],
    ], [1.1, 1.9, 2.6], bold_first=True))
    st.append(callout('Genesis id and live network details',
                      'For the genesis id and other current network information, visit the main web page at ' + link('https://mineobs.network') + '.'))

    # 4 ─ consensus
    st += section('4  Proof of Time consensus', 'How blocks are ordered')
    st.append(P('Obsidian\'s consensus identity is <b>PROOF_OF_TIME</b>. A block is valid when it is produced by the node whose turn it is, '
                'carries a timestamp the chain\'s clock accepts, and passes every state rule. How much computation anyone spent is irrelevant.', 'lead'))
    st.append(table([
        ['', 'Proof of Work', 'Obsidian Proof of Time'],
        ['What buys the right to produce a block', 'Computation spent in a race', 'The producer schedule, once protocol time has advanced'],
        ['Headline metric', 'Hash rate', 'Time-Rate: verified blocks and transactions per minute'],
        ['"Difficulty" means', 'How many hashes a block costs', 'PoT Difficulty: how block spacing compares with the 5-second target'],
        ['Fork choice', 'Most accumulated work', 'Checkpoint prefix, fixed PoT Weight, height, then lowest block hash'],
        ['Does a faster machine help?', 'Yes', 'No'],
    ], [1.3, 1.2, 2.0], bold_first=True))
    st.append(H2('4.1  The chain\'s own clock'))
    st.append(P('The clock is the <b>median timestamp of the last 11 blocks</b>. A median is used rather than a maximum or a mean so a single '
                'absurd timestamp, honest or hostile, cannot move it. Every block timestamp must satisfy three rules:'))
    st.append(code('timestamp  >  median time past of the last 11 ancestors\n'
                   'timestamp  >= parent timestamp + 1 second\n'
                   'timestamp  <= the validating node\'s own clock + 10 seconds', 'BLOCK TIMESTAMP RULES'))
    st.append(P('The first two clauses are computed entirely from chain data, so every node reaches the same verdict. A node\'s local '
                'clock is used only to reject a block that claims the future. It can never make a backdated block valid.'))
    st.append(H2('4.2  The producer set and the schedule'))
    st.append(P('Any node can become a producer by registering with its own identity key. Registration is free: no gas, no deposit and '
                'no wallet signature. Every registered node that is mature and live joins one deterministic schedule.'))
    st.append(table([
        ['Tier', 'Who is in the producer set'],
        ['Tier 1 (normal)', 'Registered, not banned, <b>mature</b> (registered at least 64 blocks ago), <b>live</b> (a sign of life within 2 days of protocol time) and not suspended.'],
        ['Tier 2', 'Used only if Tier 1 is empty: every registered, non-banned node, so a chain whose producers vanished can continue.'],
        ['Open', 'Used only when no registered node exists at all: the founding state of a fresh chain. It ends with the first accepted registration.'],
    ], [1, 4], bold_first=True))
    st.append(P('The set is sorted by producer address, so registration order and arrival time carry no weight. For each slot exactly one '
                'producer is named, derived from the parent state and the two header timestamps alone:'))
    st.append(code('round(parent, block)    = max(0, floor((block.timestamp - parent.timestamp) / 5) - 1)\n'
                   'producer(height, round) = set[(height + round) mod |set|]', 'THE SCHEDULE'))
    st.append(figure(fig_schedule(), 'Figure 2. A silent producer is skipped by the next round. The chain keeps its 5-second pace.'))
    st.append(H2('4.3  Fork choice'))
    st.append(P('A branch must contain the checkpointed prefix. Among such branches the greatest cumulative <b>PoT Weight</b> wins (every valid '
                'block adds exactly one unit), then the greatest height, then the <b>lowest block hash</b>. The final rule makes the choice fully '
                'deterministic: two honest nodes holding the same candidates choose the same head. Transaction volume, peer arrival order and '
                'header-hash grinding buy no authority. A node holds at most 8 competing candidates per height and refuses reorganisations deeper than 256 blocks.'))
    st.append(H2('4.4  Equivocation and suspension'))
    st.append(P('A producer that signs two different blocks on the same parent has equivocated. Any registered node can submit both signed '
                'headers; every node re-verifies both signatures and, if valid, the identity is <b>banned permanently</b> and its reward wallet '
                'is released. A ban needs two valid signatures from the producer\'s own key, so nobody can forge one. A producer that is merely '
                'offline is suspended for a deterministic back-off (10 minutes, doubling to a 24-hour ceiling) and returns by itself.'))
    st.append(H2('4.5  PoT Difficulty, Time-Rate and checkpoint finality'))
    st.append(P('<b>PoT Difficulty</b> is recomputed from chain history every 720 blocks and reports how actual block spacing compares with the '
                '5-second target. It is a published measurement, not an acceptance rule. <b>Time-Rate</b> replaces hash rate: verified blocks and '
                'transactions per minute of protocol time over a one-day window. Both are served by the node\'s <font name="Mono">/pot</font> route.'))
    st.append(P('The protocol also derives a <b>producer-diversity checkpoint</b> from chain history alone. A block is checkpointed once enough '
                'distinct, established producers have built on it. No votes are cast, no message is gossiped for it, and it is committed in the state root, '
                'so every node computes the same answer.'))

    # 5 ─ crypto
    st += section('5  Cryptography and identity', 'Keys, addresses and signatures')
    st.append(table([
        ['Purpose', 'Primitive'],
        ['Transaction, block and node signatures', 'secp256k1 ECDSA, 64-byte compact signatures, deterministic (RFC 6979), low-S normalised'],
        ['Address', 'Bech32 of a 20-byte hash (RIPEMD-160 of SHA-256 of the compressed public key) with a per-network prefix; 42 characters on mainnet'],
        ['Block ids, Merkle roots, state roots, PoT Weight', 'SHA-256'],
        ['Recovery phrase', '24 BIP-39 words (256 bits of entropy); derivation path <font name="Mono">m/44\'/7777\'/0\'/0/index</font>'],
        ['Browser wallet vault', 'PBKDF2-SHA256 (600,000 iterations) and AES-256-GCM; passphrase of at least 12 characters'],
        ['Node identity', 'A secp256k1 key created on the node; the node id is the 20-byte hash of its public key; the keystore is scrypt and AES-256-GCM'],
        ['Domain separation', 'Every signed message type has its own tag, for example <font name="Mono">OBSIDIAN:TX_SIGNING:v1</font>. A signature made for one purpose is never a valid transaction.'],
    ], [1.3, 3.3], bold_first=True))
    st.append(P('Hashing proves integrity and identity. It is not a competition: computing faster earns nothing, which is the whole content of "Proof of Time, not Proof of Work".'))
    st.append(H2('5.1  Wallet custody'))
    st.append(P('Keys are created in the browser from the WebCrypto secure random generator. They are never derived from an email address, '
                'username or account id, and no function in the wallet library sends key material over the network. The stored vault holds only '
                'the key-derivation parameters, salt, IV and ciphertext plus public labels. The browser wallet builds transaction bodies with the '
                'same encoder module the node uses, so a signature produced in a browser verifies on a node.'))
    st.append(P('One recovery phrase produces the same key pair on all four networks; only the address prefix and checksum change. Transactions '
                'commit to the chain ID, so a signature made on one network is useless on another.'))

    # 6 ─ ledger
    st += section('6  The ledger', 'Blocks, transactions and state')
    st.append(H2('6.1  Blocks'))
    st.append(table([
        ['Parameter', 'Value'],
        ['Target interval', '5 seconds'],
        ['Maximum block size / transactions', '2 MiB / 2,000'],
        ['Median-time-past window', '11 blocks'],
        ['Allowed future timestamp drift', '10 seconds (two slots)'],
        ['Maximum ordinary reorganisation depth', '256 blocks'],
        ['Header nonce', 'None. There is no nonce field and no difficulty target in the header.'],
    ], [2, 2.6], bold_first=True))
    st.append(P('A header commits to the height, parent hash, timestamp, cumulative PoT Weight, transactions root, events root, state root, '
                'parameters hash, protocol version, producer and the producer\'s signature. A block with one invalid transaction is rejected as a whole.'))
    st.append(H2('6.2  Transactions'))
    st.append(code('protocolVersion | chainId | sender | nonce | type | gas | body | validUntil | memo | signature',
                   'TRANSACTION ENVELOPE'))
    st.append(P('Bodies use a deterministic binary codec, so one transaction has exactly one byte representation. The maximum signed '
                'transaction is 16 KiB, a memo is at most 256 bytes, and a transaction may emit at most 64 events. Replay protection is the pair '
                '(sender, nonce), the chain ID in every signed transaction, and <font name="Mono">validUntil</font>, which may be at most 240 blocks (20 minutes) ahead. '
                'The transaction id is a hash of the canonical bytes, so it is known before broadcast.'))
    st.append(table([
        ['Id', 'Type', 'Purpose'],
        ['1', 'PAYMENT', 'Transfer OBS. Gas goes to the Mining Pool.'],
        ['2', 'ONS', 'Register, renew, transfer, accept, update, recover and configure a .obs name'],
        ['7', 'MINING_CLAIM', 'Claim the protocol mining reward'],
        ['9', 'TREASURY', 'A treasury action, signed by the treasury wallet only'],
        ['10', 'GOVERNANCE', 'Protocol governance transactions'],
        ['11', 'NODE_REGISTRY', 'Node registration, wallet binding, heartbeats, attestations, fault and equivocation reports'],
        ['13', 'GATE_AUTHORITY', 'Rotate or revoke the mining gate issuer keys, approved by a majority of the current keys'],
        ['14', 'ONS_MARKET', 'List, re-price, delist, buy, offer, accept, decline and cancel an offer on a .obs name'],
    ], [0.35, 1.2, 3.8], mono_cols=(1,)))
    st.append(P('An unknown transaction type is always a hard rejection, never a silent no-op.'))
    st.append(H2('6.3  Gas'))
    st.append(P('Every value-bearing transaction pays gas in OBS, on top of the amount, to the Mining Pool:'))
    st.append(code('gas = clamp( floor(amount x 0.02%),  0.000001 OBS,  0.01 OBS )', 'GAS RULE'))
    st.append(table([
        ['Amount sent', '0.001 OBS', '1 OBS', '10 OBS', '50 OBS', '100 OBS or more'],
        ['Gas', '0.000001 OBS', '0.0002 OBS', '0.002 OBS', '0.01 OBS', '0.01 OBS'],
    ], [1, 1, 1, 1, 1, 1.3], bold_first=True))
    st.append(P('The floor (0.000001 OBS) is also the minimum transfer, so every transaction that creates state pays the Mining Pool and spam funds '
                'miners instead of burdening them.'))
    st.append(H2('6.4  State, supply and genesis'))
    st.append(P('State is a Merkleised map: accounts (balance, nonce), the Mining Pool, the treasury, ONS records, marketplace listings and escrow, '
                'and the node registry. Each block commits to a state root and an events root, and every node verifies both after applying the block. '
                'Applying a block is a pure function of the parent state and the block, and a candidate state is committed only after its root matches.'))
    st.append(code('sum(balances) + mining pool + locked escrow and node holdings = total supply\n'
                   'total supply <= 21,000,000 OBS', 'THE SUPPLY INVARIANT, CHECKED ON EVERY BLOCK'))
    st.append(P('The one-time <b>genesis allocation of 100,000 OBS</b> is awarded atomically to the first protocol-valid mining claim on a chain. '
                'That wallet becomes the on-chain treasury wallet. A new account starts with 0 OBS, and no administrator, mint key or alternative issuance path exists.'))

    # 7 ─ mining
    st += section('7  Mining', 'Claiming OBS, one signed claim at a time')
    st.append(P('Mining on Obsidian is a <b>protocol claim</b>. The node decides whether a wallet is eligible, how much the claim pays and which '
                'claim id is next; the browser only signs and submits. Nothing in an interface can create a claim a node would not accept.', 'lead'))
    st.append(table([
        ['Parameter', 'Value'],
        ['Claim interval', '4 hours of protocol time per wallet'],
        ['Claims per cycle', '6 per 24 hours'],
        ['Reward per claim at genesis participation', '0.000166666666666666 OBS (0.001 OBS per wallet per day)'],
        ['Reduction', '0.5% per 100,000 active miners, compounding, in exact integer arithmetic'],
        ['Floor', '0.0002 OBS per wallet per day, never crossed'],
        ['Active miner', 'A wallet with at least one valid claim in the last 30 days'],
        ['Claims per wallet per block', '1'],
    ], [1.7, 2.9], bold_first=True))
    st.append(H2('7.1  The reward schedule'))
    st.append(P('The reward per claim falls as participation rises, so the schedule distributes the 21,000,000 OBS supply over a very long horizon. '
                'The values below are computed from the consensus rule with the same integer arithmetic every node uses.'))
    st.append(figure(fig_reward_curve(), 'Figure 3. Daily reward per wallet against active miners. The floor is reached at 32.2 million active miners.'))
    st.append(table([
        ['Active miners', 'Reward per day (6 claims)', 'Reward per claim'],
        ['Below 100,000', '0.001 OBS', '0.000166666666666666 OBS'],
        ['1,000,000', '0.000951110130465771 OBS', '0.000158518355077628 OBS'],
        ['5,000,000', '0.000778312557068642 OBS', '0.00012971875951144 OBS'],
        ['10,000,000', '0.000605770436490728 OBS', '0.000100961739415121 OBS'],
        ['20,000,000', '0.000366957821726167 OBS', '0.000061159636954361 OBS'],
        ['32,200,000 and above', '0.0002 OBS (floor)', '0.000033333333333333 OBS'],
    ], [1.3, 1.7, 1.7], bold_first=True))
    st.append(P('Rewards are settled from the Mining Pool first. Only the remainder is newly issued, so gas recycled into the pool pays real rewards '
                'before any new OBS is created.'))
    st.append(H2('7.2  Account-verified claims'))
    st.append(P('A claim is valid when it carries a short-lived <b>gate certificate</b> issued by the Obsidian account system for the signed-in account\'s '
                'one linked wallet. Mining therefore requires a signed-in account and a connected wallet. The certificate is valid for 15 minutes '
                'and for one claim id only. The issuer keys are committed in genesis and can be rotated on chain by approvals from a strict majority of the '
                'current keys. The chain still decides eligibility and timing from the wallet\'s own history; the gate decides only that the claim came through the account system.'))
    st.append(figure(fig_claim_flow(), 'Figure 4. The path of one claim, from sign-in to a block.'))
    st.append(H2('7.3  Replay safety'))
    st.append(P('Each claim carries a unique claim id derived by the node, a per-wallet claim sequence and the wallet\'s next nonce. One claim per wallet per block '
                'means two tabs, two devices or two nodes cannot double-claim; a mined claim cannot be mined again. Eligibility is derived from the chain head '
                'timestamp, so a device with the wrong clock can display a wrong countdown but cannot produce an eligible claim.'))
    st.append(H2('7.4  Withdrawals'))
    st.append(P('Rewards land in the wallet that claimed them. Moving them is an ordinary payment with standard gas. There is no lock-up.'))

    # 8 ─ economics
    st += section('8  Economics', 'Supply, fees and revenue')
    st.append(P('The protocol has no sale, no premine, no administrator and no mint authority. OBS is issued by exactly two rules, and every fee is paid in OBS '
                'at a price fixed by consensus.', 'lead'))
    st.append(H2('8.1  Issuance'))
    st.append(table([
        ['Path', 'Amount', 'When'],
        ['Genesis allocation', 'Exactly 100,000 OBS, once, ever', 'To the wallet behind the first protocol-valid mining claim, which becomes the treasury wallet'],
        ['Mining rewards', 'Per the schedule in section 7', 'Per accepted claim, capped by the 21,000,000 OBS supply cap'],
    ], [1.2, 1.5, 2.5], bold_first=True))
    st.append(H2('8.2  What things cost'))
    st.append(table([
        ['Action', 'Price', 'Destination'],
        ['Gas on any value-bearing transaction', 'Between 0.000001 OBS and 0.01 OBS (0.02% of the amount)', 'Mining Pool'],
        ['.obs name registration', '0.05 OBS', 'ONS revenue, split 90% / 10%'],
        ['.obs name renewal', '0.05 OBS', 'ONS revenue, split 90% / 10%'],
        ['Node registration and wallet binding', 'Nothing', 'No transfer exists'],
        ['Name transfer, acceptance, recovery', 'Nothing', 'No value moves'],
        ['Marketplace sale', 'No commission: the seller receives the full price', 'Buyer pays ordinary gas to the Mining Pool'],
    ], [1.6, 2.0, 1.5], bold_first=True))
    st.append(figure(fig_value_flows(), 'Figure 5. The three value flows of the protocol.'))
    st.append(H2('8.3  ONS revenue and the 90 / 10 split'))
    st.append(P('ONS registration and renewal fees are the protocol\'s only revenue source. They are split at the moment they are received, inside the '
                'state transition, by every node:'))
    st.append(code('nodePool = floor(total x 9000 / 10000)\n'
                   'treasury = total - nodePool', 'EXACT INTEGER SPLIT'))
    st.append(P('The treasury takes the remainder, so the two parts always add back to the whole and no unit is lost to rounding. Gas, issuance, mining '
                'rewards and the genesis allocation are never ONS revenue. The treasury share is credited in the same block as the fee; the node-runner '
                'share accumulates in the Node Runner Reward Pool and is paid once per 24-hour protocol period, by the first block after the period closes.'))
    st.append(P('Each credit is visible on the ledger. The node\'s address history lists them as <font name="Mono">ONS_TREASURY_SHARE</font>, '
                '<font name="Mono">ONS_TREASURY_RELEASE</font> and <font name="Mono">NODE_REWARD</font> entries with amount, block, time and, for a sale, the name and transaction id.'))

    # 9 ─ ONS
    st += section('9  Obsidian Name Service', 'Human-readable names as chain state')
    st.append(P('A <b>.obs</b> name maps to exactly one wallet address, and that mapping is blockchain state. Nodes recompute it, reject double '
                'registrations and apply transfers as ordinary signed transactions. No DNS, registrar or company sits in the middle.', 'lead'))
    st.append(table([
        ['Parameter', 'Value'],
        ['Registration and renewal fee', '0.05 OBS each, denominated in OBS with no exchange rate involved'],
        ['Term', '365 days'],
        ['Grace period after expiry', '30 days; only the owner can renew, nobody else can register the name'],
        ['Length', '3 to 63 characters'],
        ['Reserved names', 'Protocol-reserved names such as obs, wallet, explorer, node and api can never be registered'],
    ], [1.6, 3.3], bold_first=True))
    st.append(figure(fig_name_lifecycle(), 'Figure 6. The life of a .obs name.'))
    st.append(H2('9.1  Ownership operations'))
    st.append(P('A name never changes hands because its owner said so. Every ownership operation is a signed ONS transaction applied in consensus state, '
                'atomic, replay-safe and free of gas, since no value moves.'))
    st.append(table([
        ['Operation', 'Who signs', 'Effect'],
        ['TRANSFER (offer)', 'Current owner', 'Offers the name to one recipient. Nothing changes yet. One open offer at a time; it lapses after 7 days.'],
        ['ACCEPT_TRANSFER', 'Offered recipient', 'Atomically moves the owner, the resolved address and the remaining term to the recipient.'],
        ['CANCEL_TRANSFER', 'Owner', 'Withdraws an open offer.'],
        ['UPDATE_ADDRESS', 'Owner', 'Changes only the address the name resolves to.'],
        ['RENEW', 'Current owner', 'Extends the term. After a transfer the new owner pays all future renewals.'],
        ['SET_RECOVERY', 'Owner', 'Names a recovery address (an empty value clears it).'],
        ['START_RECOVERY', 'Recovery address', 'Proposes a new owner; takes effect only after a 7-day delay.'],
        ['CANCEL_RECOVERY', 'Owner', 'Stops a recovery in flight.'],
        ['FINALIZE_RECOVERY', 'Recovery address or new owner', 'After the delay, if the owner has not cancelled, ownership moves.'],
    ], [1.35, 1.35, 2.9], mono_cols=(0,)))
    st.append(P('A transfer to a mistyped address costs nothing: it is an offer nobody accepts, and it lapses. Any ownership change wipes the previous '
                'owner\'s open offer, pending recovery and recovery address, so a new owner never inherits the previous owner\'s recovery path. Every recipient or '
                'pointer address in a transaction must be in its canonical lowercase spelling, so two spellings of one address can never be two ledger keys.'))
    st.append(H2('9.2  Resolution'))
    st.append(P('<font name="Mono">GET /names/&lt;name&gt;</font> returns the owner, resolved address, registration and expiry times, transfer count and any pending '
                'transfer or recovery. Wallets resolve a name from the authoritative on-chain lookup for chain 7777 and show the name, the full address and the network '
                'before anything is signed. A listed name does not resolve, and wallets refuse to send to it.'))

    # 10 ─ marketplace
    st += section('10  ONS Marketplace', 'Buying and selling names on chain')
    st.append(P('The ONS Marketplace lets the owner of a .obs name sell it for a fixed price in OBS and lets anyone make an offer on a name that is not for sale. It is '
                '<b>protocol</b>, not an application: a listing, an offer, the OBS locked behind an offer and every ownership change are consensus state that every node '
                'recomputes. The interface reads that state and builds transactions the chain validates again.', 'lead'))
    st.append(table([
        ['Operation', 'Who', 'Rules'],
        ['LIST', 'Owner', 'The name must be active and not already listed, with no ordinary transfer offer and no recovery in flight. Price at least 0.001 OBS.'],
        ['UPDATE_PRICE', 'Owner', 'The name must be listed by the sender; the new price is at least the minimum.'],
        ['DELIST', 'Owner', 'Allowed during the grace period too. Restores ordinary use.'],
        ['BUY', 'Anyone but the seller', 'The transaction states the price and seller the buyer reviewed; the chain buys only if both still hold.'],
        ['OFFER', 'Anyone, on a name that is not listed', 'The offered OBS is locked in consensus escrow. At most 16 pending offers per name and 32 per maker.'],
        ['ACCEPT_OFFER', 'Owner', 'Atomically pays the owner the full offered amount and transfers the name.'],
        ['DECLINE_OFFER', 'Owner', 'Refunds the escrow to the maker.'],
        ['CANCEL_OFFER', 'Maker', 'Refunds the escrow to the maker.'],
    ], [1.2, 1.4, 3.1], mono_cols=(0,)))
    st.append(H2('10.1  Guarantees'))
    st += B([
        '<b>Atomic sale.</b> In one state transition the buyer is debited price plus gas, the seller is credited the full price, gas goes to the Mining Pool, the name moves to the buyer and the listing is deleted. A buyer can never pay without receiving the name, and a name can never move without payment.',
        '<b>No commission.</b> The seller of a listing receives exactly the price, and the seller of an accepted offer receives exactly the offered amount.',
        '<b>Price protection.</b> A buyer signs the price and seller they reviewed. If the owner re-prices or delists first, the purchase fails and nothing moves.',
        '<b>Listing lock.</b> While a name is listed, every executor that would use it as an ordinary active name refuses with <font name="Mono">ERR_NAME_LISTED</font>, and the name does not resolve.',
        '<b>Escrow.</b> Offers lapse after 7 days and their escrow returns to the maker. Settled offers stay in state for 90 days as an audit trail, and the chain\'s events keep the history permanently.',
        '<b>Ownership change clears old rights.</b> A purchase wipes the old owner\'s pending transfer, recovery and recovery address.',
    ])
    st.append(P('A wallet\'s balance reply separates <font name="Mono">spendable</font> OBS from <font name="Mono">locked</font> OBS held in offer escrow, with their sum as the total. '
                'Public read routes under <font name="Mono">/market</font> serve listings, offers, name status and history.'))

    # 11 ─ node runners
    st += section('11  Node runners', 'Independent nodes are the network')
    st.append(P('Obsidian pays for nodes from its only revenue stream. Everything about eligibility, measurement and payout is protocol state and protocol arithmetic: '
                'there is no admin panel, allowlist or discretionary allocation.', 'lead'))
    st.append(H2('11.1  Becoming a node runner'))
    st.append(P('The operator pastes an OBS address as the node\'s reward wallet. That is the whole binding step: no gas, no wallet signature, no deposit. The node then registers '
                'itself on chain with its own identity key, which never leaves the operator\'s machine. A wallet backs at most one node at a time, enforced by a consensus index, '
                'and changing a node\'s wallet is a separate delayed statement (two reward periods) that the current wallet can cancel. The owner of a wallet can release a binding '
                'with a signature from that wallet (one period).'))
    st.append(H2('11.2  How a node is measured'))
    st.append(P('A node is "up" in an hourly window if the chain contains one of its in-sync heartbeats, or a block it produced, in that window. Peers attest to each other\'s '
                'liveness, and corroborated fault reports reduce a score. A score is built from four components, each computed by every node from chain data:'))
    st.append(table([
        ['Component', 'Weight', 'What it measures'],
        ['Uptime', '40%', 'Hourly windows with chain-recorded life, 24 windows per period'],
        ['Participation', '25%', 'Blocks produced (60%) and attested peer coverage (40%)'],
        ['Reliability', '20%', 'Starts at full marks; each corroborated fault or invalid attestation removes 20%'],
        ['Responsiveness', '15%', 'Share of heartbeats reporting a height within 12 blocks of the network'],
    ], [1.2, 0.7, 3.5], bold_first=True))
    st.append(H2('11.3  Settlement'))
    st += B([
        'A reward period is 24 hours of protocol time. The first block after a period closes settles it, so payouts happen with nobody online.',
        'A node needs at least 50% verified uptime and a score of at least 10% to receive a share.',
        'One node may take at most 5% of a period\'s pool, never less than an equal split among eligible nodes, so a small network is paid in full.',
        'A node needs attestations from min(2, n-1) distinct peers before its liveness counts as independently verified.',
        'Allocations below 0.000001 OBS carry to the next period.',
        'Admission is rate limited, and a new node is schedulable only after 64 blocks.',
    ])
    st.append(P('The platform\'s Node Runners page shows the revenue totals, the exact 90/10 split, the Reward Pool and every settled period with its per-node payouts. An operator can look '
                'up a node id and see the evidence the network recorded and the score it produces.'))

    # 12 ─ products
    st += section('12  The Obsidian product suite', 'What you can use today')
    st.append(P('Five products give people access to the network. All five run against the same chain, sign transactions with the same code and show only what a node reported.', 'lead'))
    st.append(table([
        ['Product', 'Where', 'For'],
        ['Main web page', link('https://mineobs.network', 'mineobs.network'), 'Mine OBS, wallet, explorer, ONS and Marketplace, node runners, developer tools and the account system'],
        ['Web App', link('https://app.mineobs.network', 'app.mineobs.network'), 'The full Obsidian client in a browser or on a phone'],
        ['Wallet', link('https://wallet.mineobs.network', 'wallet.mineobs.network'), 'A focused non-custodial wallet'],
        ['Browser Extension', 'Chrome, Edge, Firefox', 'The Obsidian client in the toolbar, with claim alerts'],
        ['Obsidian Node', 'Windows, macOS, Linux', 'Running and operating a node, with a local dashboard'],
        ['API', link('https://api.mineobs.network', 'api.mineobs.network'), 'The official network API (see section 14)'],
    ], [1.1, 1.4, 3], bold_first=True))
    st.append(H2('12.1  The Platform'))
    st.append(P('The Platform is the public home of the network and the account system behind mining. Its sites cover Mine OBS, Wallet, Explorer, ONS with the Marketplace, Node Runners '
                'and Developer resources. It holds accounts and issues mining certificates; it never holds keys, funds, prices or consensus.'))
    st += B([
        '<b>Account.</b> Sign up with a Gmail address, a password, an invitation and multi-factor authentication. Recovery codes are shown once. Each account can invite up to five new accounts, and a new account starts with 0 OBS.',
        '<b>Mine OBS.</b> The claim screen reads eligibility from the node and shows the countdown from protocol time.',
        '<b>Explorer.</b> Blocks, transactions, claims, names and the Mining Pool, read from real nodes.',
        '<b>ONS and Marketplace.</b> Search, register, manage, list, buy and make offers on .obs names with a review screen before every signature.',
        '<b>Node Runners.</b> The reward economics and per-node evidence described in section 11.',
    ])
    st.append(H2('12.2  The Web App'))
    st.append(P('The Web App uses the Platform\'s account system and the node\'s ledger. An account made in one signs in on the other, with the same password, MFA secret, recovery codes and invitations. '
                'A claim from either product is the same claim on the ledger, and the chain prevents a double claim.'))
    st.append(table([
        ['Screen', 'What it does'],
        ['Sign up / sign in / recover', 'One account for the whole ecosystem'],
        ['Home', 'Account at a glance: recovery codes, MFA, linked address'],
        ['Mine', 'Claim once per four hours; the claim is signed in the browser'],
        ['Wallet', 'Create a wallet (24 words, proven before sealing) or import one; Receive shows your address as a QR code; Send can scan a QR into the recipient; history'],
        ['Explorer', 'Overview, blocks, claims, names, the reward pool, search'],
        ['ONS', 'Search, register, manage and list .obs names'],
        ['API', 'Run any public read the gateway allows and see the node\'s own answer'],
        ['Menu', 'MFA enrolment, invitations, link your wallet once by signing a challenge, claim alerts, sign out'],
    ], [1.3, 3.7], bold_first=True))
    st.append(H2('12.3  The Wallet'))
    st.append(P('The Wallet is a non-custodial browser wallet. It has no chain, node, key format, address format or fee rule of its own: it is a client of the network\'s own code. It serves one network, '
                'named when it starts, and verifies the network\'s identity before any signature.'))
    st.append(table([
        ['Screen', 'What it does'],
        ['Create', 'Password of at least 12 characters, then 24 real BIP-39 words from secure randomness. Nothing is stored until the backup is confirmed.'],
        ['Import', 'Recovery phrase (12 or 24 words), a private key checked on the device, or an encrypted backup made by this wallet.'],
        ['Home', 'Exact balance from the node, recent transactions, the network card'],
        ['Receive', 'Your address as a QR code the app\'s own decoder reads back; copy and share'],
        ['Send', 'Recipient and amount validation, QR scan or photo, live protocol fee'],
        ['Review', 'Recipient, amount, fee, total, balance after and network, then the password authorises the signature'],
        ['Transaction status', 'Prepared, signed, accepted by the node, in the mempool, in a block with confirmations'],
        ['Activity and Backup', 'The node\'s indexed history; encrypted backup; the phrase after the password, hidden after a minute'],
    ], [1.2, 3.8], bold_first=True))
    st.append(H2('12.4  The Browser Extension'))
    st.append(P('The Extension is a Manifest V3 extension for Chrome, Edge and Firefox. It carries the Web App\'s screens (Home, Mine, Wallet, Explorer, ONS, API and Menu) plus a Node screen with connection state, '
                'height, sync, mempool, protocol and genesis id. Every transaction is built, signed and submitted by the same core code the Web App uses. Claim alerts use the browser\'s notification API, '
                'so a due claim can notify you with no page open, and the node, not the extension, decides whether a claim is allowed.'))
    st.append(P('Its permissions are minimal: storage, alarms and notifications. Access to a server is requested per server on a click. It injects no content scripts and no dapp provider, and it runs '
                'under a strict content security policy with no eval and no remote code.'))
    st.append(H2('12.5  Obsidian Node'))
    st.append(P('Obsidian Node is the desktop application for running and operating a node. It starts the real Obsidian Core as a child process, reads its RPC on the local machine and signs with the core\'s own '
                'key and transaction code. It supports all four networks, each with its own data directory, wallet and settings.'))
    st.append(P('Its screens include Overview, Node, Node Rewards, Wallet, Transactions, Explorer, Logs and Diagnostics, Settings and Help. Wallets are encrypted vaults; the recovery phrase is shown once at creation; '
                'the renderer runs sandboxed with context isolation and a strict content security policy; and logs and diagnostics redact phrases, keys, passphrases and tokens.'))
    st.append(H2('12.6  Obsidian Core and the command line'))
    st.append(P('Obsidian Core is the reference node. It needs Node.js 20.10 or newer, one CPU core, 512 MB of memory and a few hundred megabytes of disk to follow the chain. A single command starts a node; '
                'the network must always be named, because no default network exists anywhere.'))
    st.append(code('node dist/index.js start --network mainnet             # run a node\n'
                   'node dist/index.js start --network mainnet --no-mine   # follow and validate only\n'
                   'node dist/index.js health --network mainnet            # what the node sees\n'
                   'node dist/index.js wallet new --network mainnet        # a wallet, offline\n'
                   'node dist/index.js keygen --network mainnet            # the node identity key\n'
                   'node dist/index.js register obs1...  --network mainnet # bind the reward wallet',
                   'COMMAND LINE'))
    st.append(H2('12.7  The explorer and the edge layer'))
    st.append(P('The explorer shows blocks, transactions and names read directly from nodes, and it is built on two rules. <b>It never exposes wallet balances.</b> '
                'Addresses next to a transaction are masked, enough to correlate two transactions by the same author and never enough to look up holdings. '
                '<b>Transaction ids are not wallet addresses.</b> Ids use their own format, so an address can never be mistaken for a hash.'))
    st.append(P('A Cloudflare worker serves and caches the sites at the edge. It forwards signed transactions untouched, never caches a submission, never invents a response when the origin is unreachable, and holds no key. '
                'The chain does not depend on it.'))

    # 13 ─ security design
    st += section('13  Security design', 'How the protocol and the products protect users')
    st.append(H2('13.1  In the protocol'))
    st += B([
        '<b>Replay protection.</b> Each transaction binds a sender and nonce, the chain ID and an expiry; a signature from one network is useless on another.',
        '<b>Domain-separated signatures.</b> Every signed message type has its own tag.',
        '<b>Deterministic rules.</b> Consensus parameters are compile-time constants of the protocol version, not operator settings. Changing one requires a documented protocol upgrade.',
        '<b>Verified state.</b> Every block commits to a state root and an events root that every node checks. The supply invariant is checked on every block.',
        '<b>Strict canonical encoding.</b> One transaction has one byte representation; unknown types are rejected; addresses must be in canonical lowercase.',
        '<b>Admission limits.</b> The mempool holds at most 10,000 transactions, 32 MiB and 64 per sender, and requires the account\'s next nonce, so each sender has one transaction in flight.',
        '<b>Equivocation ban.</b> Two signed blocks on one parent permanently ban a producer, provable by anyone from the two signatures.',
        '<b>Network isolation.</b> Genesis id, parameters hash, chain ID and address prefix keep the four networks apart.',
    ])
    st.append(H2('13.2  In the products'))
    st += B([
        '<b>Non-custodial keys.</b> Keys never leave the device. Vaults are PBKDF2-SHA256 (600,000 iterations) with AES-256-GCM; the vault envelope is validated before any key derivation.',
        '<b>Authenticated accounts.</b> Passwords are stored as scrypt hashes; sign-in supports TOTP multi-factor authentication and one-time recovery codes; repeated failures are rate limited per account and address.',
        '<b>Review before signing.</b> Every wallet action shows the recipient in full, the amount, the fee and the network, and signs only after the passphrase is entered.',
        '<b>Privacy by design.</b> The explorer masks addresses and answers no balance query; a balance is available only for an address the caller already knows.',
        '<b>Request limits on the node RPC.</b> 240 requests per minute per client address, a 512 KiB body limit and tight header and request timeouts.',
        '<b>Strict browser policies.</b> The apps ship security headers and content security policies; the extension and desktop app disallow eval, inline script and remote code.',
        '<b>Display integrity.</b> Amounts are formatted from exact integers (never floating point) and addresses are never altered for display, so a copied or signed address is always the stored one.',
    ])

    # 14 ─ developers
    st += section('14  Developer reference', 'Integrating with the network')
    st.append(P('The node serves an HTTP API and a JSON-RPC endpoint. Amounts are integers of <b>seals</b>: 1 OBS = 10<super>18</super> seals. Reads are unauthenticated. The official API is at ' + link('https://api.mineobs.network') + '; for the genesis id and current network details visit ' + link('https://mineobs.network') + '.', 'lead'))
    st.append(H2('14.1  Read routes'))
    st.append(table([
        ['Route', 'Returns'],
        ['GET /health, /status', 'Network, chain ID, genesis id, parameters hash, height, supply, syncing state'],
        ['GET /params', 'Protocol parameters including the parameters hash'],
        ['GET /blocks?limit=, /block/&lt;height|hash&gt;', 'Recent blocks; one full block'],
        ['GET /tx/&lt;txid&gt;', 'A transaction with inclusion height'],
        ['GET /address/&lt;address&gt;?limit=', 'Activity, mining claims and protocol credits for an address (never a balance)'],
        ['GET /wallet/&lt;address&gt;/next-nonce', 'The next nonce to sign with'],
        ['POST /wallet/balance', 'Spendable, locked and total balance of an address you already know'],
        ['GET /mining/schedule, /mining/status?address=', 'The reward schedule; eligibility for one address'],
        ['GET /names/&lt;name&gt;, /names', 'ONS records and a paged list'],
        ['GET /market, /market/listings, /market/name/&lt;name&gt;', 'Marketplace summary, listings and the status of one name'],
        ['GET /pot, /revenue, /supply', 'Proof of Time state; ONS revenue and split; supply and invariant'],
        ['GET /nodes/registry, /nodes/rewards, /nodes/status/&lt;id&gt;', 'Node runners, reward pool and per-node status'],
    ], [1.9, 2.9], mono_cols=(0,)))
    st.append(H2('14.2  Write routes'))
    st.append(table([
        ['Route', 'Body', 'Purpose'],
        ['POST /tx/submit', '{ "tx": "&lt;signed hex&gt;" }', 'Validate and admit to the mempool; returns the transaction id'],
        ['POST /tx/simulate', '{ "tx": "&lt;signed hex&gt;" }', 'Run against current state without committing'],
        ['POST /tx/encode', '{ "type", "payload" }', 'Canonical body encoding and its inverse'],
        ['POST /tx/gas', '{ "amountObs": "12.5" }', 'Deterministic gas quote'],
        ['POST /wallet/quote', '{ "address" }', 'Balance, next nonce and gas estimate for planning'],
    ], [1.4, 1.8, 2.0], mono_cols=(0,)))
    st.append(code('# next nonce for a sender, then the gas for 12.5 OBS\n'
                   'curl -s http://127.0.0.1:8630/wallet/<address>/next-nonce\n'
                   'curl -s -X POST http://127.0.0.1:8630/tx/gas \\\n'
                   '     -H \'content-type: application/json\' -d \'{"amountObs":"12.5"}\'\n\n'
                   '# submit a signed transaction (hex built and signed locally)\n'
                   'curl -s -X POST http://127.0.0.1:8630/tx/submit \\\n'
                   '     -H \'content-type: application/json\' -d \'{"tx":"<signed hex>"}\'',
                   'EXAMPLES AGAINST A LOCAL NODE (MAINNET RPC PORT 8630)'))
    st.append(H2('14.3  Signing a transaction'))
    st.append(P('A client builds the canonical body with the shared encoder, fills the envelope, hashes it under the signing domain and signs it with secp256k1. The transaction id is known before broadcast. '
                'A wallet confirms one transaction before sending the next from the same sender, because the mempool admits only the account\'s next nonce. The reference signing code is in '
                '<font name="Mono">obsidian-core/src/transactions</font> and in the Web App\'s signing bundle.'))
    st.append(P('Errors use stable codes such as <font name="Mono">ERR_BAD_NONCE</font>, <font name="Mono">ERR_WRONG_CHAIN_ID</font>, <font name="Mono">ERR_MINING_TOO_SOON</font>, '
                '<font name="Mono">ERR_NAME_LISTED</font> and <font name="Mono">ERR_MARKET_PRICE_MISMATCH</font>, so clients can react to a rejection precisely.'))

    # appendices
    st += section('Appendix A  Protocol parameters', 'Reference')
    st.append(P('Every value below is a consensus constant of protocol 2.0.2. A node reports the parameters hash in <font name="Mono">GET /params</font>; for this release it is '
                '<font name="Mono">12211595855ba405b3d70f6161ef9371</font> on every network.'))
    st.append(table([
        ['Group', 'Parameter', 'Value'],
        ['Supply', 'Maximum supply', '21,000,000 OBS'],
        ['', 'Genesis allocation', '100,000 OBS, once'],
        ['', 'Decimals / smallest unit', '18 / 1 seal = 10<super>-18</super> OBS'],
        ['Blocks', 'Target interval', '5 seconds'],
        ['', 'Maximum size / transactions', '2 MiB / 2,000'],
        ['', 'Median-time-past window', '11 blocks'],
        ['', 'Future drift allowed', '10 seconds'],
        ['', 'Maximum reorganisation depth', '256 blocks'],
        ['', 'PoT Difficulty window', '720 blocks'],
        ['Transactions', 'Maximum size / memo / events', '16 KiB / 256 bytes / 64'],
        ['', 'Expiry window', '240 blocks'],
        ['', 'Minimum transfer', '0.000001 OBS'],
        ['Gas', 'Rate / minimum / maximum', '0.02% / 0.000001 OBS / 0.01 OBS'],
        ['Mining', 'Claim interval / claims per cycle', '4 hours / 6 per 24 hours'],
        ['', 'Reward per claim at genesis participation', '0.000166666666666666 OBS'],
        ['', 'Reduction / step / daily floor', '0.5% / 100,000 active miners / 0.0002 OBS'],
        ['', 'Active-miner window', '30 days'],
        ['Mining gate', 'Certificate validity / clock skew', '15 minutes / 60 seconds'],
        ['', 'Maximum issuer keys / changes per update', '8 / 8'],
        ['Producers', 'Maturity / liveness window', '64 blocks / 2 days'],
        ['', 'Misses before suspension / first suspension / ceiling', '3 / 10 minutes / 24 hours'],
        ['', 'Registrations per block / candidates per height', '2 / 8'],
        ['ONS', 'Registration and renewal fee', '0.05 OBS'],
        ['', 'Term / grace / name length', '365 days / 30 days / 3 to 63'],
        ['', 'Transfer offer / recovery delay', '7 days / 7 days'],
        ['Marketplace', 'Minimum price and offer', '0.001 OBS'],
        ['', 'Offer lifetime / retention of settled offers', '7 days / 90 days'],
        ['', 'Pending offers per name / per maker', '16 / 32'],
        ['', 'Commission', 'None'],
        ['Node rewards', 'Revenue split', '90% node pool / 10% treasury'],
        ['', 'Period / uptime window', '24 hours / 1 hour'],
        ['', 'Minimum uptime / minimum score', '50% / 10%'],
        ['', 'Per-node ceiling / minimum payout', '5% of the pool / 0.000001 OBS'],
        ['', 'Wallet change delay / reclaim delay', '2 periods / 1 period'],
        ['Accounts', 'Invitations per account / starting balance', '5 / 0 OBS'],
    ], [0.9, 2.6, 2.2], zebra=True, pad=(2.4, 2.9)))

    st += section('Appendix B  Glossary', 'Reference')
    st.append(table([
        ['Term', 'Meaning'],
        ['OBS', 'Obsidian Seal Coin, the native coin of the Obsidian chain'],
        ['Seal', 'The smallest unit of OBS: 10<super>-18</super> OBS'],
        ['Proof of Time (PoT)', 'Consensus in which block production follows a deterministic schedule gated by protocol time'],
        ['Protocol time', 'The timestamps committed in block headers, summarised by the median of the last 11 blocks'],
        ['PoT Weight', 'Fixed fork-choice weight: one unit per valid block'],
        ['PoT Difficulty', 'A published measurement of how block spacing compares with the 5-second target'],
        ['Time-Rate', 'Verified blocks and transactions per minute of protocol time'],
        ['Producer', 'A registered node scheduled to produce a block in a given slot'],
        ['Slot / round', 'A 5-second interval of protocol time / the number of skipped slots before a block'],
        ['Mining claim', 'A signed transaction that claims the protocol reward for a wallet'],
        ['Gate certificate', 'A short-lived signature authorising one claim for one wallet from a signed-in account'],
        ['Mining Pool', 'Protocol state that holds gas and pays mining rewards before new issuance'],
        ['ONS', 'Obsidian Name Service: .obs names as chain state'],
        ['Treasury wallet', 'The wallet that made the first valid mining claim on a chain; receives 10% of ONS revenue'],
        ['Node Runner Reward Pool', 'Protocol state that holds 90% of ONS revenue until each period settles'],
        ['Escrow', 'OBS locked by consensus behind a pending marketplace offer'],
    ], [1.4, 3.8], bold_first=True))

    st += section('Appendix C  Document information', 'Reference')
    st.append(table([
        ['Item', 'Detail'],
        ['Title', 'Obsidian Network: White Paper'],
        ['Subtitle', 'The Proof of Time Blockchain'],
        ['Coin', 'Obsidian Seal Coin (OBS)'],
        ['Version', '1.1, 24 October 2026'],
        ['Describes', 'Obsidian Core 2.0.4, protocol 2.0.2, Mainnet chain ID 7777'],
        ['Publisher', 'Emolux Labs'],
        ['Main web page', link('https://mineobs.network')],
        ['Web App', link('https://app.mineobs.network')],
        ['Wallet web app', link('https://wallet.mineobs.network')],
        ['API', link('https://api.mineobs.network')],
        ['Genesis id and network details', 'Visit ' + link('https://mineobs.network')],
        ['Source code', link('https://github.com/EmoluxLabs/Obsidian-Network', 'github.com/EmoluxLabs/Obsidian-Network') + '  ·  Apache-2.0'],
        ['Contact', link('mailto:emoluxlabs@gmail.com', 'emoluxlabs@gmail.com')],
    ], [1, 3.4], bold_first=True))
    st.append(Spacer(1, 6))
    st.append(H2('Version history'))
    st.append(table([
        ['Version', 'Date', 'Notes'],
        ['1.1', '24 October 2026', 'Added the official links, including the API; genesis id and live network details point to the main web page'],
        ['1.0', '24 October 2026', 'First edition of the Obsidian Network White Paper'],
    ], [0.8, 1.4, 3.2]))
    return st


def main():
    doc = Doc(OUT)
    story = [PageBreak()] if False else []
    # page 1 is the cover (template draws everything); body story starts after it
    first = [Spacer(1, 1)]
    st = build()
    merged = []
    for it in st:
        if isinstance(it, Heading) and it.level == 1:
            merged.append(CondPageBreak(48 * mm))
        elif type(it) is Paragraph and it.style.name == 'h3':
            merged.append(CondPageBreak(34 * mm))
        if getattr(it, '_iscode', False) and merged and type(merged[-1]) is Paragraph and merged[-1].style.name in ('body', 'lead'):
            prev = merged.pop()
            merged.append(KeepTogether([prev] + list(it._content)))
        else:
            merged.append(it)
    doc.multiBuild(first + merged)
    print('wrote', os.path.abspath(OUT))


if __name__ == '__main__':
    main()
