#!/usr/bin/env python3
"""Extract PDF pages as WebP images for the LearningApp reader.

Usage:
    python3 scripts/extract_pages.py <path-to-pdf> [--dpi 150] [--quality 75]

Output goes to public/pages/ as page-001.webp, page-002.webp, etc.
Also generates public/pages/manifest.json with page count and dimensions.
"""
import argparse
import json
import os
import sys
import time

import fitz  # PyMuPDF
from PIL import Image


def extract(pdf_path: str, dpi: int = 150, quality: int = 75):
    out_dir = os.path.join(os.path.dirname(__file__), "..", "public", "pages")
    os.makedirs(out_dir, exist_ok=True)

    doc = fitz.open(pdf_path)
    total = len(doc)
    print(f"Extracting {total} pages at {dpi} DPI, WebP quality {quality}...")

    manifest = {"total_pages": total, "dpi": dpi, "pages": []}
    start = time.time()

    for i in range(total):
        page = doc[i]
        mat = fitz.Matrix(dpi / 72, dpi / 72)
        pix = page.get_pixmap(matrix=mat)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)

        filename = f"page-{i + 1:03d}.webp"
        filepath = os.path.join(out_dir, filename)
        img.save(filepath, "WEBP", quality=quality)

        size_kb = os.path.getsize(filepath) / 1024
        manifest["pages"].append(
            {
                "file": filename,
                "width": pix.width,
                "height": pix.height,
                "size_kb": round(size_kb, 1),
            }
        )

        if (i + 1) % 20 == 0 or i == total - 1:
            elapsed = time.time() - start
            rate = (i + 1) / elapsed
            eta = (total - i - 1) / rate if rate > 0 else 0
            print(f"  [{i + 1}/{total}] {filename} ({size_kb:.0f} KB) — ETA {eta:.0f}s")

    # Write manifest
    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    total_mb = sum(p["size_kb"] for p in manifest["pages"]) / 1024
    elapsed = time.time() - start
    print(f"\nDone! {total} pages → {total_mb:.1f} MB in {elapsed:.0f}s")
    print(f"Output: {out_dir}")
    print(f"Manifest: {manifest_path}")

    doc.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract PDF pages as WebP images")
    parser.add_argument("pdf", help="Path to PDF file")
    parser.add_argument("--dpi", type=int, default=150, help="Render DPI (default: 150)")
    parser.add_argument("--quality", type=int, default=75, help="WebP quality (default: 75)")
    args = parser.parse_args()

    if not os.path.exists(args.pdf):
        print(f"Error: {args.pdf} not found")
        sys.exit(1)

    extract(args.pdf, args.dpi, args.quality)
