#!/usr/bin/env python3
"""Generate the Cowork PWA app icons (no external deps).

Renders a black, full-bleed icon with a white speech bubble + three dots
(a "session / chat" mark) at 2x supersampling, then downsamples.
Outputs PNGs used by cowork.html / manifest.webmanifest.
"""
import struct, zlib, math, os

OUT = os.path.dirname(os.path.abspath(__file__))

# Palette
BG = (13, 14, 16)        # near-black (matches --bg dark)
FG = (243, 244, 246)     # near-white (matches --ink dark)
DOT = (13, 14, 16)

def rounded_rect_sdf(px, py, cx, cy, hw, hh, r):
    """Signed distance to a rounded rectangle centered at (cx,cy)."""
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    ax = max(qx, 0.0); ay = max(qy, 0.0)
    return math.sqrt(ax*ax + ay*ay) + min(max(qx, qy), 0.0) - r

def render(size):
    ss = 2
    S = size * ss
    buf = bytearray(S * S * 4)
    # bubble geometry in unit (0..1) space
    bx, by = 0.50, 0.46          # bubble center
    bhw, bhh = 0.30, 0.225       # bubble half-extents
    br = 0.085                    # corner radius
    # tail tip
    tail = [(0.40, 0.685), (0.52, 0.685), (0.40, 0.80)]
    dots_y = 0.46
    dots = [0.36, 0.50, 0.64]
    dot_r = 0.035

    def point_in_tri(px, py, tri):
        (x1,y1),(x2,y2),(x3,y3) = tri
        d1 = (px-x2)*(y1-y2)-(x1-x2)*(py-y2)
        d2 = (px-x3)*(y2-y3)-(x2-x3)*(py-y3)
        d3 = (px-x1)*(y3-y1)-(x3-x1)*(py-y1)
        neg = (d1<0) or (d2<0) or (d3<0)
        pos = (d1>0) or (d2>0) or (d3>0)
        return not (neg and pos)

    for j in range(S):
        v = (j + 0.5) / S
        for i in range(S):
            u = (i + 0.5) / S
            r, g, b = BG
            # bubble (rounded rect) or tail -> white
            sdf = rounded_rect_sdf(u, v, bx, by, bhw, bhh, br)
            inside_bubble = sdf < 0
            inside_tail = point_in_tri(u, v, tail)
            if inside_bubble or inside_tail:
                r, g, b = FG
                # three dots punched out of the bubble
                for dx in dots:
                    if (u-dx)**2 + (v-dots_y)**2 <= dot_r*dot_r:
                        r, g, b = DOT
                        break
            o = (j * S + i) * 4
            buf[o] = r; buf[o+1] = g; buf[o+2] = b; buf[o+3] = 255

    # downsample ss x ss (box filter)
    out = bytearray(size * size * 4)
    for j in range(size):
        for i in range(size):
            ar=ag=ab=aa=0
            for dj in range(ss):
                for di in range(ss):
                    o = ((j*ss+dj)*S + (i*ss+di)) * 4
                    ar+=buf[o]; ag+=buf[o+1]; ab+=buf[o+2]; aa+=buf[o+3]
            n = ss*ss
            oo = (j*size + i) * 4
            out[oo]=ar//n; out[oo+1]=ag//n; out[oo+2]=ab//n; out[oo+3]=aa//n
    return out

def write_png(path, size, rgba):
    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)
    raw = bytearray()
    for j in range(size):
        raw.append(0)  # filter: none
        raw.extend(rgba[(j*size)*4:(j*size+size)*4])
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)

for size, name in [(512, "cowork-icon-512.png"),
                   (192, "cowork-icon-192.png"),
                   (180, "cowork-icon-180.png")]:
    write_png(os.path.join(OUT, name), size, render(size))
    print("wrote", name)
