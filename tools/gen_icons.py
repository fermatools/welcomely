"""Gera os ícones do Welcomely (SVG e PNG) sem dependências externas.

Desenho: calendário branco com um "check" sobre fundo verde-azulado FERMATools.
Uso:  python tools/gen_icons.py
"""
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_ICONS = os.path.join(ROOT, "web", "icons")

BRAND = (0x00, 0x69, 0x5C)
BAND = (0xB2, 0xDF, 0xDB)
WHITE = (0xFF, 0xFF, 0xFF)

# Formas em coordenadas 0..100 (as mesmas do SVG).
CAL = (22, 27, 78, 80, 7)            # x0, y0, x1, y1, raio
BAND_RECT = (22, 27, 78, 40)
RINGS = [(33, 20, 38, 32, 2.5), (62, 20, 67, 32, 2.5)]
CHECK = [(36, 60), (46, 69.5), (64, 51)]
CHECK_W = 5.5


def svg(maskable=False):
    s = 0.8 if maskable else 1.0
    t = 50 * (1 - s)
    bg = '<rect width="100" height="100" fill="#00695c"/>' if maskable \
        else '<rect width="100" height="100" rx="22" fill="#00695c"/>'
    x0, y0, x1, y1, r = CAL
    pts = " ".join(f"{x},{y}" for x, y in CHECK)
    rings = "".join(f'<rect x="{a}" y="{b}" width="{c - a}" height="{d - b}" rx="{rr}" fill="#fff"/>' for a, b, c, d, rr in RINGS)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        f'{bg}<g transform="translate({t} {t}) scale({s})">'
        f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" rx="{r}" fill="#fff"/>'
        f'<path d="M{x0} {y0 + r}a{r} {r} 0 0 1 {r} -{r}h{x1 - x0 - 2 * r}a{r} {r} 0 0 1 {r} {r}V{BAND_RECT[3]}H{x0}z" fill="#b2dfdb"/>'
        f'{rings}<polyline points="{pts}" fill="none" stroke="#00695c" stroke-width="{CHECK_W}" '
        'stroke-linecap="round" stroke-linejoin="round"/></g></svg>\n'
    )


# ------------------------------------------------------------ rasterização

def sd_round_rect(px, py, x0, y0, x1, y1, r):
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hx, hy = (x1 - x0) / 2 - r, (y1 - y0) / 2 - r
    qx, qy = abs(px - cx) - hx, abs(py - cy) - hy
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r


def sd_segment(px, py, ax, ay, bx, by):
    pax, pay, bax, bay = px - ax, py - ay, bx - ax, by - ay
    h = max(0.0, min(1.0, (pax * bax + pay * bay) / (bax * bax + bay * bay)))
    return math.hypot(pax - bax * h, pay - bay * h)


def coverage(d, px_size):
    return max(0.0, min(1.0, 0.5 - d / px_size))


def blend(dst, color, a):
    return tuple(dst[i] * (1 - a) + color[i] * a for i in range(3)), a


def render(size, maskable=False):
    s = 0.8 if maskable else 1.0
    off = 50 * (1 - s)
    unit = 100 / size              # tamanho de um pixel em unidades do desenho
    rows = []
    for j in range(size):
        row = bytearray([0])
        for i in range(size):
            x, y = (i + 0.5) * unit, (j + 0.5) * unit
            bg_a = 1.0 if maskable else coverage(sd_round_rect(x, y, 0, 0, 100, 100, 22), unit)
            if bg_a == 0:
                row += b"\0\0\0\0"
                continue
            c = BRAND
            u, v, k = (x - off) / s, (y - off) / s, unit / s   # coordenadas do conteúdo
            cal = sd_round_rect(u, v, *CAL)
            a = coverage(cal, k)
            if a:
                c, _ = blend(c, WHITE, a)
                band = max(cal, v - BAND_RECT[3])
                c, _ = blend(c, BAND, coverage(band, k))
            for ring in RINGS:
                c, _ = blend(c, WHITE, coverage(sd_round_rect(u, v, *ring), k))
            d = min(sd_segment(u, v, *CHECK[0], *CHECK[1]), sd_segment(u, v, *CHECK[1], *CHECK[2])) - CHECK_W / 2
            c, _ = blend(c, BRAND, coverage(d, k))
            row += bytes([round(c[0]), round(c[1]), round(c[2]), round(bg_a * 255)])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def main():
    os.makedirs(WEB_ICONS, exist_ok=True)
    with open(os.path.join(WEB_ICONS, "icon.svg"), "w", encoding="utf-8") as f:
        f.write(svg())
    for name, size, maskable in [("icon-192.png", 192, False), ("icon-512.png", 512, False),
                                 ("icon-maskable-512.png", 512, True)]:
        with open(os.path.join(WEB_ICONS, name), "wb") as f:
            f.write(render(size, maskable))
        print("gerado:", name)


if __name__ == "__main__":
    main()
