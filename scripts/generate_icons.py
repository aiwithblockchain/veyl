#!/usr/bin/env python3
"""Generate Veyl app icons from the icon masters.

Two masters live in `src-tauri/icons/source/`, both produced by
`build/logo-variants/make-app-icon.py`:

  app-icon.png        >= 64px   母版原样
  app-icon-mid.png    32-63px   内部压平，去掉细碎明暗层次
  app-icon-small.png  16-31px   内部换成两区实心形状

三档**容器完全一致**（同样的暗底与辉光），只有内部不同——所以同一个 App 在
访达列表、访达图标视图、Dock、切换器里看到的是同一个标志的不同尺度。

`veyl.png` 是原始素材，不再被本脚本直接读取，也不被修改。

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
ICONS = ROOT / "src-tauri" / "icons"
SOURCE = ICONS / "source" / "app-icon.png"
MID_SOURCE = ICONS / "source" / "app-icon-mid.png"
SMALL_SOURCE = ICONS / "source" / "app-icon-small.png"
BUILD = ROOT / "build" / "icons"

MAC_CANVAS = 1024
MAC_ART = 824
MAC_MARGIN = (MAC_CANVAS - MAC_ART) // 2
MAC_RADIUS = 185

# 分档：16-31 用简化内部，32-63 用压平内部，64 起用母版原样。
MID_THRESHOLD = 32
FULL_THRESHOLD = 64


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


def pick_master(
    large: Image.Image, mid: Image.Image, small: Image.Image, size: int
) -> Image.Image:
    if size < MID_THRESHOLD:
        return small
    if size < FULL_THRESHOLD:
        return mid
    return large


def hairline(image: Image.Image, size: int) -> Image.Image:
    """在最终尺寸上给圆角方加一圈极淡描边。

    容器是深青，放在深色桌面上边界会糊，所以描边用**浅色**——白色不到一成
    透明度，只在深色背景上浮出来一条极细的轮廓，浅色桌面上几乎看不见。

    描边必须在最终尺寸上画：在 1024 母版上画 2px，缩到 16px 只剩 0.03px。
    """
    # 16px 上 1px 描边就占掉图标宽度的 6%，看起来像一个灰框。
    # 那个尺寸下球体本身就是对比，不需要靠描边定义边界。
    if size < 32:
        return image
    margin = round(100 * size / MAC_CANVAS)
    radius = max(2, round(MAC_RADIUS * size / MAC_CANVAS))
    edge = image.copy()
    draw = ImageDraw.Draw(edge)
    draw.rounded_rectangle(
        [margin, margin, size - margin - 1, size - margin - 1],
        radius=radius,
        outline=(255, 255, 255, 30),
        width=1,
    )
    return edge


def save_png(image: Image.Image, path: Path, size: int, border: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    out = resized(image, size)
    if border:
        out = hairline(out, size)
    out.save(path, "PNG")


def write_macos(large: Image.Image, mid: Image.Image, small: Image.Image) -> None:
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
        save_png(pick_master(large, mid, small, size), iconset / name, size, border=True)

    iconutil = shutil.which("iconutil")
    if iconutil:
        subprocess.run(
            [iconutil, "-c", "icns", str(iconset), "-o", str(ICONS / "icon.icns")],
            check=True,
        )
    else:
        print("warning: iconutil not found, skipped icon.icns", file=sys.stderr)


def write_windows(large: Image.Image, mid: Image.Image, small: Image.Image) -> None:
    frames = [
        resized(pick_master(large, mid, small, size), size)
        for size in (16, 32, 48, 256)
    ]
    frames[-1].save(
        ICONS / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (256, 256)],
        append_images=frames[:-1],
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
        save_png(pick_master(large, mid, small, size), ICONS / name, size)


def write_generic(large: Image.Image, mid: Image.Image, small: Image.Image) -> None:
    for name, size in [
        ("32x32.png", 32),
        ("64x64.png", 64),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
        ("icon.png", 1024),
    ]:
        save_png(pick_master(large, mid, small, size), ICONS / name, size)


def main() -> int:
    for path in (SOURCE, MID_SOURCE, SMALL_SOURCE):
        if not path.exists():
            print(f"error: missing icon master {path}", file=sys.stderr)
            print(
                "       run: python3 build/logo-variants/make-app-icon.py",
                file=sys.stderr,
            )
            return 1

    large_square = make_square_master(Image.open(SOURCE).convert("RGBA"))
    mid_square = make_square_master(Image.open(MID_SOURCE).convert("RGBA"))
    small_square = make_square_master(Image.open(SMALL_SOURCE).convert("RGBA"))

    BUILD.mkdir(parents=True, exist_ok=True)
    large_macos = make_macos_master(large_square)
    mid_macos = make_macos_master(mid_square)
    small_macos = make_macos_master(small_square)
    for name, image in (
        ("macos-1024.png", large_macos),
        ("macos-1024-mid.png", mid_macos),
        ("macos-1024-small.png", small_macos),
    ):
        image.save(BUILD / name, "PNG")

    write_macos(large_macos, mid_macos, small_macos)
    write_windows(large_square, mid_square, small_square)
    write_generic(large_square, mid_square, small_square)

    print(f"macOS master: {BUILD / 'macos-1024.png'}")
    print(f"macOS master (mid): {BUILD / 'macos-1024-mid.png'}")
    print(f"macOS master (small): {BUILD / 'macos-1024-small.png'}")
    print(f"icons written to: {ICONS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
