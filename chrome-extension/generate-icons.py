#!/usr/bin/env python3
"""
Génère les icônes PNG requises par l'extension Chrome.
Utilise uniquement les modules de la bibliothèque standard Python.
Usage : python3 generate-icons.py
"""
import math
import os
import struct
import zlib


def make_png(size: int) -> bytes:
    """Génère un PNG RGBA de taille `size`x`size` avec une cloche stylisée."""
    cx, cy = size / 2.0, size / 2.0

    def pixel(px: int, py: int) -> tuple[int, int, int, int]:
        # Normalisation en coordonnées [-1, 1]
        nx = (px - cx) / (size * 0.5)
        ny = (py - cy) / (size * 0.5)

        # Corps de la cloche (ellipse)
        in_body = (nx ** 2 / 0.62 ** 2 + (ny + 0.06) ** 2 / 0.66 ** 2) < 1 and ny < 0.44

        # Tige au sommet
        in_handle = abs(nx) < 0.13 and -0.85 < ny < -0.52

        # Battant en bas
        in_clapper = nx ** 2 + (ny - 0.60) ** 2 < 0.13 ** 2

        if in_body or in_handle or in_clapper:
            return (26, 115, 232, 255)   # Google Blue
        return (0, 0, 0, 0)             # Transparent

    # Construction des données brutes
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter byte = None
        for x in range(size):
            raw.extend(pixel(x, y))

    compressed = zlib.compress(bytes(raw), 9)

    def chunk(name: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(name + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + name + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", compressed)
    png += chunk(b"IEND", b"")
    return png


if __name__ == "__main__":
    out_dir = os.path.join(os.path.dirname(__file__), "icons")
    os.makedirs(out_dir, exist_ok=True)

    for size in (16, 32, 48, 128):
        path = os.path.join(out_dir, f"icon{size}.png")
        with open(path, "wb") as f:
            f.write(make_png(size))
        print(f"✓  icons/icon{size}.png")

    print("\nIcônes générées avec succès !")
