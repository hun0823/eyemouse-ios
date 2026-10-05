#!/usr/bin/env python3
"""Generate App Icon and splash PNGs without Pillow."""
from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "ios/App/App/Assets.xcassets/AppIcon.appiconset"
SPLASH_DIR = ROOT / "ios/App/App/Assets.xcassets/Splash.imageset"


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path: Path, width: int, height: int, rgba: bytes) -> None:
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        raw.extend(rgba[y * stride : (y + 1) * stride])
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def clamp(v: float) -> int:
    return max(0, min(255, int(round(v))))


def mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return (
        clamp(a[0] + (b[0] - a[0]) * t),
        clamp(a[1] + (b[1] - a[1]) * t),
        clamp(a[2] + (b[2] - a[2]) * t),
    )


def paint_icon(size: int) -> bytes:
    bg = (14, 20, 27)
    card = (26, 36, 49)
    mint = (142, 224, 194)
    gold = (255, 213, 106)
    ink = (244, 247, 251)
    out = bytearray(size * size * 4)
    cx = cy = (size - 1) / 2.0
    r_outer = size * 0.46
    r_card = size * 0.38
    r_eye = size * 0.16
    r_iris = size * 0.075
    r_pupil = size * 0.032
    for y in range(size):
        for x in range(size):
            dx = x - cx
            dy = y - cy
            dist = math.hypot(dx, dy)
            nx = dx / size
            ny = dy / size
            t = min(1.0, dist / (size * 0.72))
            rgb = mix(card, bg, t * t)
            if dist < r_outer:
                edge = 1.0 - abs(dist - r_outer + size * 0.012) / (size * 0.018)
                if 0 < edge < 1:
                    rgb = mix(rgb, mint, max(0.0, min(1.0, edge)) * 0.55)
            if dist < r_card:
                rgb = mix(rgb, (22, 32, 44), 0.15)
            # almond eye
            eye = (nx / 0.22) ** 2 + (ny / 0.12) ** 2
            if eye < 1.0:
                rgb = mix(ink, mint, 0.12)
                iris = math.hypot(nx + 0.02, ny + 0.01)
                if iris < 0.105:
                    rgb = mix(mint, (40, 90, 80), iris / 0.105)
                if iris < 0.045:
                    rgb = (10, 16, 20)
                if math.hypot(nx - 0.03, ny - 0.03) < 0.018:
                    rgb = ink
            # soft gaze cursor (bottom-right of eye)
            cdx = nx - 0.18
            cdy = ny - 0.20
            if math.hypot(cdx, cdy) < 0.055:
                rgb = gold
            # corner highlight
            if dist < r_eye * 0.2:
                pass
            i = (y * size + x) * 4
            out[i : i + 4] = bytes((rgb[0], rgb[1], rgb[2], 255))
    return bytes(out)


def paint_splash(width: int, height: int) -> bytes:
    bg = (14, 20, 27)
    mint = (142, 224, 194)
    gold = (255, 213, 106)
    out = bytearray(width * height * 4)
    cx, cy = width / 2.0, height * 0.46
    scale = min(width, height)
    for y in range(height):
        for x in range(width):
            dx = (x - cx) / scale
            dy = (y - cy) / scale
            dist = math.hypot(dx, dy)
            glow = max(0.0, 1.0 - dist / 0.55)
            rgb = mix(bg, (20, 32, 40), glow * 0.35)
            # faint gold rim at top
            if y < height * 0.04:
                rgb = mix(rgb, gold, 0.18 * (1.0 - y / (height * 0.04)))
            eye = (dx / 0.16) ** 2 + (dy / 0.085) ** 2
            if eye < 1.0:
                rgb = mix((236, 242, 248), mint, 0.18)
                iris = math.hypot(dx + 0.015, dy + 0.008)
                if iris < 0.075:
                    rgb = mix(mint, (30, 70, 62), iris / 0.075)
                if iris < 0.03:
                    rgb = (10, 16, 20)
            if math.hypot(dx - 0.13, dy - 0.14) < 0.038:
                rgb = gold
            i = (y * width + x) * 4
            out[i : i + 4] = bytes((rgb[0], rgb[1], rgb[2], 255))
    return bytes(out)


def main() -> None:
    icon = paint_icon(1024)
    write_png(ICON_DIR / "AppIcon-512@2x.png", 1024, 1024, icon)
    splash = paint_splash(1366, 1366)
    write_png(SPLASH_DIR / "splash-2732x2732.png", 1366, 1366, splash)
    write_png(SPLASH_DIR / "splash-2732x2732-1.png", 1366, 1366, splash)
    write_png(SPLASH_DIR / "splash-2732x2732-2.png", 1366, 1366, splash)
    print("wrote icons and splash")


if __name__ == "__main__":
    main()
