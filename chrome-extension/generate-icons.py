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
    """Génère un PNG RGBA de taille `size`x`size` avec un canard stylisé."""
    cx, cy = size / 2.0, size / 2.0

    def pixel(px: int, py: int) -> tuple[int, int, int, int]:
        # Normalisation en coordonnées : nx/ny ∈ [-1, 1], ny positif vers le bas
        nx = (px - cx) / (size * 0.5)
        ny = (py - cy) / (size * 0.5)

        # Corps (grande ellipse jaune, légèrement à droite et en bas)
        in_body = ((nx - 0.12) ** 2 / 0.72 ** 2 + (ny - 0.22) ** 2 / 0.52 ** 2) < 1

        # Tête (cercle jaune, en haut à gauche)
        in_head = (nx + 0.20) ** 2 + (ny + 0.46) ** 2 < 0.36 ** 2

        # Queue (ovale vertical, côté droit, dépasse vers le haut)
        in_tail = ((nx - 0.78) ** 2 / 0.20 ** 2 + (ny + 0.12) ** 2 / 0.50 ** 2) < 1

        in_duck = in_body or in_head or in_tail

        # Bec (triangle orange pointant à gauche, attaché à la tête)
        beak_t = (nx + 0.82) / 0.26   # 0 à la pointe, 1 à la base
        in_beak = -0.82 < nx < -0.56 and abs(ny + 0.46) < 0.13 * beak_t

        # Œil (petit cercle sombre)
        in_eye = (nx + 0.30) ** 2 + (ny + 0.54) ** 2 < 0.08 ** 2

        # Aile (ovale légèrement plus sombre à l'intérieur du corps)
        in_wing = ((nx - 0.15) ** 2 / 0.40 ** 2 + (ny - 0.22) ** 2 / 0.26 ** 2) < 1

        if in_eye:
            return (25, 20, 35, 255)       # œil sombre
        if in_beak:
            return (255, 120, 0, 255)      # bec orange
        if in_duck and in_wing:
            return (210, 162, 0, 255)      # aile dorée foncée
        if in_duck:
            return (255, 204, 0, 255)      # corps jaune canard
        return (0, 0, 0, 0)               # transparent

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
