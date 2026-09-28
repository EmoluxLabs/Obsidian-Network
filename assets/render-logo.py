#!/usr/bin/env python3
"""
Render the Obsidian coin logo to PNG without any external dependency.

The mark is authored as geometry here and in assets/logo.svg; this script is the
rasteriser (supersampled polygon fill, linear/radial gradient shaders, zlib PNG
writer). It exists so the repository can ship raster brand assets on a machine
with no SVG toolchain — run it whenever the SVG changes:

    python3 assets/render-logo.py

Outputs: logo-512.png, logo-192.png, logo-32.png, favicon.ico
"""
import math
import struct
import zlib

SIZE = 1024  # supersampled canvas; final assets are downsampled from this
SS = 2       # extra supersampling for antialiasing


def hexagon(cx, cy, r, rotation=-math.pi / 2):
    return [(cx + r * math.cos(rotation + i * math.pi / 3), cy + r * math.sin(rotation + i * math.pi / 3)) for i in range(6)]


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(len(a)))


class Canvas:
    def __init__(self, size):
        self.size = size
        self.px = [[(0, 0, 0, 0)] * size for _ in range(size)]

    def point_in_polygon(self, x, y, poly):
        inside = False
        n = len(poly)
        for i in range(n):
            x1, y1 = poly[i]
            x2, y2 = poly[(i + 1) % n]
            if (y1 > y) != (y2 > y):
                xin = (x2 - x1) * (y - y1) / (y2 - y1) + x1
                if x < xin:
                    inside = not inside
        return inside

    def polygon(self, poly, shader):
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        x0, x1 = max(0, int(min(xs))), min(self.size - 1, int(max(xs)) + 1)
        y0, y1 = max(0, int(min(ys))), min(self.size - 1, int(max(ys)) + 1)
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                if self.point_in_polygon(x + 0.5, y + 0.5, poly):
                    self.px[y][x] = shader(x + 0.5, y + 0.5)

    def rounded_rect(self, x0, y0, x1, y1, radius, shader):
        for y in range(int(y0), int(y1) + 1):
            for x in range(int(x0), int(x1) + 1):
                cx = min(max(x, x0 + radius), x1 - radius)
                cy = min(max(y, y0 + radius), y1 - radius)
                if (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius:
                    self.px[y][x] = shader(x + 0.5, y + 0.5)


def linear(p0, p1, c0, c1):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length2 = dx * dx + dy * dy

    def shader(x, y):
        t = ((x - p0[0]) * dx + (y - p0[1]) * dy) / length2
        t = min(1.0, max(0.0, t))
        return (*lerp(c0, c1, t), 255)

    return shader


def radial(center, radius, c_inner, c_outer):
    def shader(x, y):
        d = math.hypot(x - center[0], y - center[1]) / radius
        t = min(1.0, max(0.0, d))
        return (*lerp(c_inner, c_outer, t), 255)

    return shader


def flat(color, alpha=255):
    return lambda x, y: (*color, alpha)


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
            if a == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((r // a, g // a, b // a, a // count))
        out.append(row)
    return out


def build():
    size = SIZE
    c = size / 2
    canvas = Canvas(size)

    # Coin body: dark obsidian disc with a rounded-square silhouette.
    canvas.rounded_rect(size * 0.02, size * 0.02, size * 0.98, size * 0.98, size * 0.22,
                       radial((c, size * 0.30), size * 0.95, (27, 36, 52), (5, 7, 12)))

    # Faceted rim.
    canvas.polygon(hexagon(c, c, size * 0.455), flat((35, 47, 69)))
    canvas.polygon(hexagon(c, c, size * 0.435), radial((c, c), size * 0.62, (255, 217, 138), (168, 106, 16)))

    # Inner crystal faces (the coin's "obsidian" core).
    top = (c, c - size * 0.345)
    upper_left = (c - size * 0.30, c - size * 0.11)
    upper_right = (c + size * 0.30, c - size * 0.11)
    lower_left = (c - size * 0.205, c + size * 0.30)
    lower_right = (c + size * 0.205, c + size * 0.30)
    canvas.polygon([top, upper_left, (c, c + size * 0.055)], flat((255, 230, 173), 235))
    canvas.polygon([top, upper_right, (c, c + size * 0.055)], flat((200, 135, 27), 235))
    canvas.polygon([upper_left, lower_left, (c, c + size * 0.055)], flat((138, 88, 12), 235))
    canvas.polygon([upper_right, lower_right, (c, c + size * 0.055)], flat((168, 106, 16), 235))
    canvas.polygon([lower_left, (c, c + size * 0.40), lower_right, (c, c + size * 0.055)], flat((122, 78, 10), 235))

    # Cyan glint: the network's cold accent, deliberately off-centre.
    canvas.polygon(hexagon(c, c, size * 0.145), flat((5, 7, 12), 235))
    canvas.polygon(hexagon(c, c, size * 0.095), radial((c, c - size * 0.02), size * 0.16, (130, 240, 240), (30, 143, 143)))

    # A single thin seam between the two upper facets: the mark reads as a cut
    # crystal without a highlight competing with the cyan core.
    canvas.polygon(
        [(top[0], top[1]), (c - size * 0.012, c - size * 0.11), (c + size * 0.012, c - size * 0.11)],
        flat((255, 236, 190), 90),
    )

    return canvas


def main():
    canvas = build()
    small = downsample(canvas, 512)
    write_png('logo-512.png', small, 512)
    write_png('logo-192.png', downsample(canvas, 192), 192)
    write_png('logo-32.png', downsample(canvas, 32), 32)

    # favicon.ico with the 32px image embedded as PNG (supported by every browser
    # that matters, and smaller than the legacy BMP payload).
    png_bytes = open('logo-32.png', 'rb').read()
    header = struct.pack('<HHH', 0, 1, 1)
    entry = struct.pack('<BBBBHHII', 32, 32, 0, 0, 1, 32, len(png_bytes), 22)
    with open('favicon.ico', 'wb') as handle:
        handle.write(header + entry + png_bytes)
    print('wrote logo-512.png, logo-192.png, logo-32.png, favicon.ico')


if __name__ == '__main__':
    main()
