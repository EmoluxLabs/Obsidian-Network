#!/usr/bin/env python3
"""
Render the official Obsidian (OBS) coin logo to PNG without any dependency.

The mark is a minted coin: a black obsidian face inside a brushed-silver rim, a
ring of stars, a ring of circuit traces, and at the centre a heavy silver "O"
cut through by a diagonal blade.

It is authored twice — as geometry in assets/logo.svg (the source of truth for
the web) and as geometry here (the rasteriser), because the build machine has no
SVG toolchain. Keep the two in step: run this whenever logo.svg changes.

    python3 assets/render-logo.py

Outputs (written next to this file): logo-512.png, logo-192.png, logo-32.png,
favicon.ico.
"""
import math
import os
import struct
import zlib

SIZE = 2048  # supersampled canvas; final assets are downsampled from this
VIEW = 512.0  # the SVG's coordinate space, so both files use the same numbers


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(len(a)))


class Canvas:
    """A tiny RGBA raster target with painter's-algorithm compositing."""

    def __init__(self, size):
        self.size = size
        self.scale = size / VIEW
        self.px = [[(0, 0, 0, 0)] * size for _ in range(size)]

    # ── geometry helpers (all inputs are in SVG view units) ──────────────────

    def _to_px(self, value):
        return value * self.scale

    def _blend(self, x, y, colour):
        r, g, b, a = colour
        if a <= 0:
            return
        if a >= 255:
            self.px[y][x] = (int(r), int(g), int(b), 255)
            return
        dr, dg, db, da = self.px[y][x]
        alpha = a / 255.0
        out_a = alpha + (da / 255.0) * (1 - alpha)
        if out_a <= 0:
            self.px[y][x] = (0, 0, 0, 0)
            return
        nr = (r * alpha + dr * (da / 255.0) * (1 - alpha)) / out_a
        ng = (g * alpha + dg * (da / 255.0) * (1 - alpha)) / out_a
        nb = (b * alpha + db * (da / 255.0) * (1 - alpha)) / out_a
        self.px[y][x] = (int(nr), int(ng), int(nb), int(out_a * 255))

    def disc(self, cx, cy, r, shader, inner=0.0, clip=None):
        """Filled circle, or an annulus when `inner` is given."""
        cx, cy, r, inner = (self._to_px(v) for v in (cx, cy, r, inner))
        x0, x1 = max(0, int(cx - r) - 1), min(self.size - 1, int(cx + r) + 1)
        y0, y1 = max(0, int(cy - r) - 1), min(self.size - 1, int(cy + r) + 1)
        r2, inner2 = r * r, inner * inner
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                px, py = x + 0.5, y + 0.5
                d2 = (px - cx) ** 2 + (py - cy) ** 2
                if d2 > r2 or d2 < inner2:
                    continue
                if clip and not clip(px / self.scale, py / self.scale):
                    continue
                self._blend(x, y, shader(px / self.scale, py / self.scale))

    def polygon(self, points, shader, clip=None):
        pts = [(self._to_px(x), self._to_px(y)) for x, y in points]
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        x0, x1 = max(0, int(min(xs)) - 1), min(self.size - 1, int(max(xs)) + 1)
        y0, y1 = max(0, int(min(ys)) - 1), min(self.size - 1, int(max(ys)) + 1)
        n = len(pts)
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                px, py = x + 0.5, y + 0.5
                inside = False
                for i in range(n):
                    ax, ay = pts[i]
                    bx, by = pts[(i + 1) % n]
                    if (ay > py) != (by > py):
                        xin = (bx - ax) * (py - ay) / (by - ay) + ax
                        if px < xin:
                            inside = not inside
                if not inside:
                    continue
                if clip and not clip(px / self.scale, py / self.scale):
                    continue
                self._blend(x, y, shader(px / self.scale, py / self.scale))

    def segment(self, x0, y0, x1, y1, width, shader):
        """A round-capped line, drawn as a quad plus two end discs."""
        dx, dy = x1 - x0, y1 - y0
        length = math.hypot(dx, dy)
        if length == 0:
            self.disc(x0, y0, width / 2, shader)
            return
        nx, ny = -dy / length * width / 2, dx / length * width / 2
        self.polygon([(x0 + nx, y0 + ny), (x1 + nx, y1 + ny), (x1 - nx, y1 - ny), (x0 - nx, y0 - ny)], shader)
        self.disc(x0, y0, width / 2, shader)
        self.disc(x1, y1, width / 2, shader)

    def path(self, points, width, shader):
        for index in range(len(points) - 1):
            (x0, y0), (x1, y1) = points[index], points[index + 1]
            self.segment(x0, y0, x1, y1, width, shader)

    def star(self, cx, cy, outer, inner, shader, rotation=-math.pi / 2):
        points = []
        for index in range(10):
            radius = outer if index % 2 == 0 else inner
            angle = rotation + index * math.pi / 5
            points.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
        self.polygon(points, shader)


# ── shaders ──────────────────────────────────────────────────────────────────


def linear(p0, p1, stops):
    """Multi-stop linear gradient; `stops` is [(offset, (r,g,b)), ...]."""
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length2 = dx * dx + dy * dy or 1.0

    def shader(x, y):
        t = ((x - p0[0]) * dx + (y - p0[1]) * dy) / length2
        t = min(1.0, max(0.0, t))
        for index in range(len(stops) - 1):
            o0, c0 = stops[index]
            o1, c1 = stops[index + 1]
            if o0 <= t <= o1:
                local = (t - o0) / (o1 - o0) if o1 > o0 else 0.0
                return (*lerp(c0, c1, local), 255)
        return (*stops[-1][1], 255)

    return shader


def radial(center, radius, stops):
    def shader(x, y):
        t = min(1.0, max(0.0, math.hypot(x - center[0], y - center[1]) / radius))
        for index in range(len(stops) - 1):
            o0, c0 = stops[index]
            o1, c1 = stops[index + 1]
            if o0 <= t <= o1:
                local = (t - o0) / (o1 - o0) if o1 > o0 else 0.0
                return (*lerp(c0, c1, local), 255)
        return (*stops[-1][1], 255)

    return shader


def flat(colour, alpha=255):
    return lambda x, y: (*colour, alpha)


# ── the mark ─────────────────────────────────────────────────────────────────

RIM = linear((60, 0), (450, 512), [
    (0.00, (255, 255, 255)),
    (0.18, (232, 236, 241)),
    (0.38, (154, 163, 173)),
    (0.52, (242, 245, 248)),
    (0.72, (125, 134, 143)),
    (0.88, (215, 220, 226)),
    (1.00, (92, 100, 108)),
])
RIM_INNER = linear((460, 26), (51, 486), [
    (0.00, (203, 210, 217)),
    (0.45, (111, 119, 127)),
    (0.70, (226, 231, 236)),
    (1.00, (74, 81, 88)),
])
FACE = radial((184, 154), 435, [(0.0, (36, 40, 45)), (0.45, (18, 20, 23)), (1.0, (5, 5, 6))])
CORE = radial((194, 164), 410, [(0.0, (27, 30, 34)), (1.0, (3, 3, 4))])
SILVER = linear((51, 26), (461, 486), [
    (0.00, (255, 255, 255)),
    (0.30, (223, 228, 234)),
    (0.55, (142, 151, 159)),
    (0.78, (238, 241, 245)),
    (1.00, (107, 115, 122)),
])
BLADE = linear((435, 51), (102, 461), [
    (0.00, (255, 255, 255)),
    (0.35, (233, 237, 241)),
    (0.60, (170, 178, 186)),
    (1.00, (244, 247, 250)),
])

# Circuit traces, in SVG coordinates — the same polyline list as logo.svg.
TRACES = [
    [(150, 154), (150, 128), (206, 128), (206, 108)],
    [(222, 116), (274, 116), (274, 98)],
    [(292, 108), (292, 130), (340, 130), (340, 152)],
    [(362, 176), (386, 176), (386, 216)],
    [(398, 232), (398, 280), (380, 280)],
    [(386, 300), (386, 336), (360, 336), (360, 358)],
    [(338, 372), (300, 372), (300, 396)],
    [(282, 404), (232, 404), (232, 396)],
    [(206, 398), (172, 398), (172, 360)],
    [(150, 344), (126, 344), (126, 300)],
    [(114, 282), (114, 234), (134, 234)],
    [(124, 214), (124, 178), (150, 178)],
    [(168, 196), (196, 196)],
    [(318, 196), (344, 196)],
    [(168, 318), (196, 318)],
    [(318, 318), (344, 318)],
]
PADS = [(206, 106), (274, 96), (398, 232), (300, 398), (126, 300), (124, 176), (386, 338), (172, 358)]

# The blade quad, and the corridor it cuts out of the O.
BLADE_QUAD = [(362.0, 112.0), (239.1, 243.6), (150.0, 400.0), (272.9, 268.4)]
BLADE_CUT = [(337.0, 93.6), (125.0, 381.6), (175.0, 418.4), (387.0, 130.4)]


def point_in(points, x, y):
    inside = False
    n = len(points)
    for i in range(n):
        ax, ay = points[i]
        bx, by = points[(i + 1) % n]
        if (ay > y) != (by > y):
            xin = (bx - ax) * (y - ay) / (by - ay) + ax
            if x < xin:
                inside = not inside
    return inside


def build():
    canvas = Canvas(SIZE)

    # Coin body.
    canvas.disc(256, 256, 246, RIM)
    canvas.disc(256, 256, 232, flat((10, 11, 13)))
    canvas.disc(256, 256, 226, RIM_INNER)
    canvas.disc(256, 256, 218, FACE)

    # Star ring: 22 stars on a circle, matching logo.svg's placements.
    star_shader = flat((238, 241, 245))
    for index in range(22):
        angle = -math.pi / 2 + index * (2 * math.pi / 22)
        cx = 256 + 228 * math.cos(angle)
        cy = 256 + 228 * math.sin(angle)
        canvas.star(cx, cy, 11, 4.6, star_shader)

    # Inner minted ring.
    canvas.disc(256, 256, 185.5, RIM_INNER, inner=178.5)
    canvas.disc(256, 256, 172, flat((11, 12, 14)))
    canvas.disc(256, 256, 127.5, flat((95, 102, 109)), inner=124.5)

    # Circuit traces and their pads.
    trace_shader = flat((201, 208, 215), 230)
    for polyline in TRACES:
        canvas.path(polyline, 3.2, trace_shader)
    for cx, cy in PADS:
        canvas.disc(cx, cy, 5, flat((230, 234, 239)))
    for x, y, w, h in [(130, 240, 16, 8), (366, 240, 16, 8), (240, 126, 8, 16), (264, 370, 8, 16)]:
        canvas.polygon([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], flat((170, 178, 186), 205))

    # Central disc.
    canvas.disc(256, 256, 118, CORE)
    canvas.disc(256, 256, 119, flat((58, 64, 70)), inner=117)

    # The struck O, cut where the blade crosses it.
    canvas.disc(256, 256, 88, SILVER, inner=52, clip=lambda x, y: not point_in(BLADE_CUT, x, y))

    # The blade.
    canvas.polygon(BLADE_QUAD, BLADE)
    canvas.polygon([(362.0, 112.0), (239.1, 243.6), (256, 256)], flat((255, 255, 255), 128))
    canvas.polygon([(150.0, 400.0), (272.9, 268.4), (256, 256)], flat((126, 134, 142), 102))

    return canvas


# ── output ───────────────────────────────────────────────────────────────────


def write_png(path, pixels, size):
    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as handle:
        handle.write(png)


def downsample(canvas, target):
    factor = canvas.size // target
    out = []
    for y in range(target):
        row = []
        for x in range(target):
            r = g = b = a = 0
            for dy in range(factor):
                for dx in range(factor):
                    pr, pg, pb, pa = canvas.px[y * factor + dy][x * factor + dx]
                    r += int(pr) * int(pa)
                    g += int(pg) * int(pa)
                    b += int(pb) * int(pa)
                    a += int(pa)
            count = factor * factor
            row.append((0, 0, 0, 0) if a == 0 else (r // a, g // a, b // a, a // count))
        out.append(row)
    return out


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    canvas = build()
    for target in (512, 192, 32):
        write_png(os.path.join(here, f'logo-{target}.png'), downsample(canvas, target), target)

    png_bytes = open(os.path.join(here, 'logo-32.png'), 'rb').read()
    header = struct.pack('<HHH', 0, 1, 1)
    entry = struct.pack('<BBBBHHII', 32, 32, 0, 0, 1, 32, len(png_bytes), 22)
    with open(os.path.join(here, 'favicon.ico'), 'wb') as handle:
        handle.write(header + entry + png_bytes)
    print('wrote logo-512.png, logo-192.png, logo-32.png, favicon.ico')


if __name__ == '__main__':
    main()
