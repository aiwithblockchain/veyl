#!/usr/bin/env python3
"""Generate Veyl tray icons with distinct silhouettes.

Outputs (all reproducible from this script, Pillow required):
  icons/tray-{idle,connected,error}-mac.png      32x32 template (black + alpha)
  icons/tray-{idle,connected,error}-win-{16,20,24,32}.png  colored for Windows

Shapes are chosen so the silhouette reads at 16pt:
  idle      -> shield outline
  connected -> check mark
  error     -> rounded triangle with an exclamation cut out
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"

MASTER = 128  # render large, downsample for clean edges
SCALE = MASTER / 32


def scaled(points):
    return [(x * SCALE, y * SCALE) for x, y in points]


def canvas():
    return Image.new("L", (MASTER, MASTER), 0)


def shield_mask():
    image = canvas()
    draw = ImageDraw.Draw(image)
    outer = [(16, 2.5), (27, 6.5), (26.5, 17.5), (16, 29.5), (5.5, 17.5), (5, 6.5)]
    inner = [(16, 9.5), (22, 12), (21.5, 17.5), (16, 23.5), (10.5, 17.5), (10, 12)]
    draw.polygon(scaled(outer), fill=255)
    draw.polygon(scaled(inner), fill=0)
    return image


def check_mask():
    image = canvas()
    draw = ImageDraw.Draw(image)
    points = [(6, 17), (13, 24), (26, 7)]
    draw.line(scaled(points), fill=255, width=int(8 * SCALE), joint="curve")
    radius = 4
    for x, y in (points[0], points[-1]):
        draw.ellipse(
            scaled(
                [
                    (x - radius, y - radius),
                    (x + radius, y + radius),
                ]
            ),
            fill=255,
        )
    return image


def error_mask():
    image = canvas()
    draw = ImageDraw.Draw(image)
    triangle = [(16, 3.5), (28.5, 28.0), (3.5, 28.0)]
    draw.polygon(scaled(triangle), fill=255)
    # 圆角：三个顶点各叠一个圆，剪影仍是三角。
    for x, y in triangle:
        radius = 2.5
        draw.ellipse(
            scaled([(x - radius, y - radius), (x + radius, y + radius)]),
            fill=255,
        )
    # 镂空感叹号。16px 下细节会被吃掉，所以笔画要粗、间隙要留够：
    # 竖条宽 3.2 单位（16px 下约 1.6px），与下方圆点的间隙 2.2 单位。
    draw.rounded_rectangle(
        scaled([(14.4, 9.2), (17.6, 17.2)]),
        radius=int(1.5 * SCALE),
        fill=0,
    )
    draw.ellipse(scaled([(14.2, 21.2), (17.8, 24.4)]), fill=0)
    return image


MASKS = {
    "idle": shield_mask(),
    "connected": check_mask(),
    "error": error_mask(),
}

# Windows 彩色：深色任务栏下也要可辨。
COLORS = {
    "idle": (148, 163, 184, 255),
    "connected": (34, 197, 94, 255),
    "error": (239, 68, 68, 255),
}


def resize(mask, size):
    return mask.resize((size, size), Image.LANCZOS)


def write_template(name, size=32):
    mask = resize(MASKS[name], size)
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    black = Image.new("RGBA", (size, size), (0, 0, 0, 255))
    image.paste(black, (0, 0), mask)
    image.save(ICONS / f"tray-{name}-mac.png")


def write_colored(name, size):
    mask = resize(MASKS[name], size)
    color = Image.new("RGBA", (size, size), COLORS[name])
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    image.paste(color, (0, 0), mask)
    image.save(ICONS / f"tray-{name}-win-{size}.png")


def main():
    ICONS.mkdir(parents=True, exist_ok=True)
    for name in MASKS:
        write_template(name)
        for size in (16, 20, 24, 32):
            write_colored(name, size)
        # 清理旧的三态文件，避免 lifecycle 误引用。
        legacy = ICONS / f"tray-{name}.png"
        if legacy.exists():
            legacy.unlink()
    print("wrote tray icons to", ICONS)


if __name__ == "__main__":
    main()
