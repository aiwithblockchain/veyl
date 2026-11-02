#!/usr/bin/env python3
"""Generate Veyl app icons from veyl.png.

macOS follows the Big Sur icon grid: 824x824 rounded artwork centered on a
1024x1024 transparent canvas (100px margin, 185px corner radius).
Windows/Linux use the full-bleed square artwork.

Usage: python3 scripts/generate_icons.py
"""

from pathlib import Path
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "veyl.png"
ICONS = ROOT / "src-tauri" / "icons"
BUILD = ROOT / "build" / "icons"

MAC_CANVAS = 1024
MAC_ART = 824
MAC_MARGIN = (MAC_CANVAS - MAC_ART) // 2
MAC_RADIUS = 185


def resized(image: Image.Image, size: int) -> Image.Image:
    return image.resize((size, size), Image.LANCZOS)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def make_macos_master(source: Image.Image) -> Image.Image:
    art = resized(source, MAC_ART)
    art.putalpha(rounded_mask(MAC_ART, MAC_RADIUS))
    canvas = Image.new("RGBA", (MAC_CANVAS, MAC_CANVAS), (0, 0, 0, 0))
    canvas.paste(art, (MAC_MARGIN, MAC_MARGIN), art)
    return canvas


def make_square_master(source: Image.Image) -> Image.Image:
    return source.convert("RGBA")


def save_png(image: Image.Image, path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    resized(image, size).save(path, "PNG")


def write_macos(icon_master: Image.Image) -> None:
    iconset = ICONS / "AppIcon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir(parents=True)

    entries = [
        ("icon_16x16.png", 16),
        ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32),
        ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128),
        ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256),
        ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512),
        ("icon_512x512@2x.png", 1024),
    ]
    for name, size in entries:
        save_png(icon_master, iconset / name, size)

    iconutil = shutil.which("iconutil")
    if iconutil:
        subprocess.run(
            [iconutil, "-c", "icns", str(iconset), "-o", str(ICONS / "icon.icns")],
            check=True,
        )
    else:
        print("warning: iconutil not found, skipped icon.icns", file=sys.stderr)


def write_windows(icon_master: Image.Image) -> None:
    ico = resized(icon_master, 256)
    ico.save(
        ICONS / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (256, 256)],
    )

    for name, size in [
        ("StoreLogo.png", 50),
        ("Square30x30Logo.png", 30),
        ("Square44x44Logo.png", 44),
        ("Square71x71Logo.png", 71),
        ("Square89x89Logo.png", 89),
        ("Square107x107Logo.png", 107),
        ("Square142x142Logo.png", 142),
        ("Square150x150Logo.png", 150),
        ("Square284x284Logo.png", 284),
        ("Square310x310Logo.png", 310),
    ]:
        save_png(icon_master, ICONS / name, size)


def write_generic(icon_master: Image.Image) -> None:
    for name, size in [
        ("32x32.png", 32),
        ("64x64.png", 64),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
        ("icon.png", 1024),
    ]:
        save_png(icon_master, ICONS / name, size)


def main() -> int:
    if not SOURCE.exists():
        print(f"error: missing source image {SOURCE}", file=sys.stderr)
        return 1

    source = Image.open(SOURCE).convert("RGBA")
    BUILD.mkdir(parents=True, exist_ok=True)

    macos_master = make_macos_master(source)
    square_master = make_square_master(source)

    macos_master.save(BUILD / "macos-1024.png", "PNG")
    square_master.save(BUILD / "square-1024.png", "PNG")

    write_macos(macos_master)
    write_windows(square_master)
    write_generic(square_master)

    print(f"macOS master: {BUILD / 'macos-1024.png'}")
    print(f"square master: {BUILD / 'square-1024.png'}")
    print(f"icons written to: {ICONS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
