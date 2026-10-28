#!/usr/bin/env python3
"""Regenerate site/og.png from brand/og.html (chromium headless + Pillow check)."""
import os
import subprocess
import sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "brand", "og.html")
OUT = os.path.join(ROOT, "site", "og.png")
MAX_BYTES = 300 * 1024
CHROMIUM = "/snap/bin/chromium"

subprocess.run([
    CHROMIUM, "--headless", "--hide-scrollbars", "--window-size=1200,630",
    f"--screenshot={OUT}", f"file://{SRC}",
], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

im = Image.open(OUT)
assert im.size == (1200, 630), f"bad size {im.size}"
size = os.path.getsize(OUT)
print(f"rendered: {im.size} {im.mode} {size} bytes")

if size > MAX_BYTES:
    im.convert("RGB").save(OUT, optimize=True)
    size = os.path.getsize(OUT)
    print(f"optimized: {size} bytes")
if size > MAX_BYTES:
    im.convert("RGB").quantize(colors=64).save(OUT, optimize=True)
    size = os.path.getsize(OUT)
    print(f"quantized: {size} bytes")
if size > MAX_BYTES:
    jpg = OUT[:-4] + ".jpg"
    im.convert("RGB").save(jpg, quality=85, optimize=True)
    print(f"STILL OVER LIMIT: saved {jpg} ({os.path.getsize(jpg)} bytes)")
    sys.exit(1)

assert Image.open(OUT).size == (1200, 630)
print(f"OK: {OUT} {size} bytes (<= {MAX_BYTES})")
