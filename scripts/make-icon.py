#!/usr/bin/env python3
"""生成指挥室的赛博霓虹图标（public/icon.png + public/icon.ico）。

为什么用脚本而不是手搓图片：图标要同时出现在桌面快捷方式、任务栏、浏览器标签页，
尺寸从 16px 到 256px，每档都得清晰。脚本化之后改配色/形状重跑一次就行。

设计：深空紫底 + 霓虹六边形（青）+ 三根均衡条（粉/青/紫）。
16px 时六边形会糊，所以均衡条做得粗、间距大 —— 小尺寸下真正看到的是"三根发光的条"。

用法（需要 Pillow，DSH 捆绑的 Python 自带）：
    python scripts/make-icon.py
"""
from __future__ import annotations

import io
import math
import struct
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"

# 与 styles.css 里的 --pink / --cyan / --violet 保持一致
PINK = (255, 46, 166)
CYAN = (34, 233, 255)
VIOLET = (163, 130, 255)
VOID_TOP = (12, 4, 33)
VOID_BOTTOM = (26, 10, 56)

S = 1024  # 超采样尺寸，最后再缩到各档


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    img = Image.new("RGB", (size, size), top)
    draw = ImageDraw.Draw(img)
    for y in range(size):
        t = math.sqrt(y / (size - 1))
        color = (
            round(top[0] + (bottom[0] - top[0]) * t),
            round(top[1] + (bottom[1] - top[1]) * t),
            round(top[2] + (bottom[2] - top[2]) * t),
        )
        draw.line([(0, y), (size, y)], fill=color)
    return img


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def hexagon(cx: float, cy: float, r: float) -> list[tuple[float, float]]:
    """尖顶朝上的正六边形。"""
    return [
        (cx + r * math.cos(math.radians(90 + 60 * i)), cy - r * math.sin(math.radians(90 + 60 * i)))
        for i in range(6)
    ]


def draw_grid(draw: ImageDraw.ImageDraw, size: int, step: int) -> None:
    for x in range(0, size + 1, step):
        draw.line([(x, 0), (x, size)], fill=(34, 233, 255, 16), width=2)
    for y in range(0, size + 1, step):
        draw.line([(0, y), (size, y)], fill=(34, 233, 255, 16), width=2)


def build() -> Image.Image:
    base = vertical_gradient(S, VOID_TOP, VOID_BOTTOM).convert("RGBA")

    # 底色的两团氛围光：左上粉、右下青
    haze = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    hz = ImageDraw.Draw(haze)
    hz.ellipse([-S * 0.15, -S * 0.30, S * 0.72, S * 0.42], fill=PINK + (64,))
    hz.ellipse([S * 0.38, S * 0.62, S * 1.18, S * 1.25], fill=CYAN + (52,))
    haze = haze.filter(ImageFilter.GaussianBlur(S * 0.10))
    base = Image.alpha_composite(base, haze)

    # 网格（很淡，只在中间区域露出来）
    grid = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw_grid(ImageDraw.Draw(grid), S, S // 14)
    grid_mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(grid_mask).ellipse([S * 0.08, S * 0.08, S * 0.92, S * 0.92], fill=190)
    grid_mask = grid_mask.filter(ImageFilter.GaussianBlur(S * 0.06))
    base.paste(grid, (0, 0), Image.composite(grid_mask, Image.new("L", (S, S), 0), grid.split()[3]))

    cx = cy = S / 2

    # ── 六边形光环：先画一层模糊的做外发光，再压一层清晰线 ────────────────
    radius = S * 0.335
    points = hexagon(cx, cy, radius)

    halo = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(halo).line(points + [points[0]], fill=CYAN + (200,), width=int(S * 0.030), joint="curve")
    halo = halo.filter(ImageFilter.GaussianBlur(S * 0.030))
    base = Image.alpha_composite(base, halo)

    ring = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    # 六条边分别上色：左上粉 → 顶青 → 右下紫，比单色描边更有"信号在环里流动"的感觉
    edge_colors = [PINK, PINK, CYAN, CYAN, VIOLET, VIOLET]
    for i in range(6):
        a = points[i]
        b = points[(i + 1) % 6]
        rd.line([a, b], fill=edge_colors[i] + (225,), width=int(S * 0.018))
    inner = hexagon(cx, cy, radius * 0.86)
    rd.line(inner + [inner[0]], fill=VIOLET + (95,), width=int(S * 0.005), joint="curve")
    base = Image.alpha_composite(base, ring)

    # ── 三根均衡条 ────────────────────────────────────────────────────────
    bars = [(PINK, 0.20), (CYAN, 0.30), (VIOLET, 0.15)]
    bar_w = S * 0.075
    gap = S * 0.052
    total_w = len(bars) * bar_w + (len(bars) - 1) * gap
    x = cx - total_w / 2
    baseline = cy + S * 0.135

    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    crisp = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    cd = ImageDraw.Draw(crisp)

    for color, height in bars:
        h = S * height
        box = [x, baseline - h, x + bar_w, baseline]
        gd.rounded_rectangle(box, radius=bar_w / 2, fill=color + (220,))
        cd.rounded_rectangle(box, radius=bar_w / 2, fill=color + (255,))
        # 顶部一道细白高光：让条看起来是发光体，而不是一块塑料。
        # 注意必须用"与白色预混合后的不透明色"——直接在 RGBA 层上画半透明白会
        # 覆盖掉原本的 alpha（Pillow 的 draw 不做 alpha 混合），缩到 16px 就成了灰点。
        sheen = tuple(round(c + (255 - c) * 0.62) for c in color)
        cd.rounded_rectangle(
            [box[0] + bar_w * 0.30, box[1] + bar_w * 0.20, box[2] - bar_w * 0.30, box[1] + bar_w * 0.44],
            radius=bar_w / 4,
            fill=sheen + (255,),
        )
        x += bar_w + gap

    base = Image.alpha_composite(base, glow.filter(ImageFilter.GaussianBlur(S * 0.035)))
    base = Image.alpha_composite(base, crisp)

    # ── 圆角裁切 + 描边 ──────────────────────────────────────────────────
    mask = rounded_mask(S, int(S * 0.225))
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)

    edge = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(
        [S * 0.012, S * 0.012, S - S * 0.012, S - S * 0.012],
        radius=int(S * 0.215),
        outline=PINK + (110,),
        width=int(S * 0.008),
    )
    out = Image.alpha_composite(out, edge)
    return out


def _dib_frame(img: Image.Image) -> bytes:
    """把一张图编码成 ICO 用的 32 位 BMP(DIB) 帧。

    ICO 里的 DIB 帧不是独立 .bmp 文件：没有文件头，直接是 40 字节
    BITMAPINFOHEADER + 自下而上的 BGRA 像素 + 1bpp AND 掩码（掩码全 0，
    透明度交给 alpha 通道）。
    """
    img = img.convert("RGBA")
    w, h = img.size
    src = img.tobytes()  # 自上而下 RGBA

    rows = []
    for y in range(h - 1, -1, -1):  # 自下而上
        start = y * w * 4
        row = bytearray()
        for x in range(start, start + w * 4, 4):
            r, g, b, a = src[x : x + 4]
            row += bytes((b, g, r, a))
        rows.append(bytes(row))
    pixels = b"".join(rows)

    mask_stride = ((w + 31) // 32) * 4  # 1bpp，每行 4 字节对齐
    mask = b"\x00" * (mask_stride * h)

    header = struct.pack(
        "<IiiHHIIiiII",
        40,  # biSize
        w,  # biWidth
        h * 2,  # biHeight：DIB 帧要算上 AND 掩码，所以是两倍
        1,  # biPlanes
        32,  # biBitCount
        0,  # biCompression = BI_RGB
        len(pixels) + len(mask),  # biSizeImage
        0, 0, 0, 0,  # 分辨率与调色板字段，均无关
    )
    return header + pixels + mask


def write_ico(icon: Image.Image, path: Path, sizes: list[int]) -> None:
    """手写多尺寸 ICO。

    为什么不用 `PIL.Image.save(format="ICO", sizes=...)`：Pillow 会把**每一帧**
    都存成 PNG。Windows 资源管理器只可靠支持 256×256 的 PNG 帧，更小的 PNG 帧
    会让整个 ICO 解析失败、退回通用文件图标（实测：桌面快捷方式图标不变）。
    所以 16–128 存 32 位 DIB，256 存 PNG（体积小很多，且 256 用 PNG 是官方约定）。
    """
    frames: list[tuple[int, bytes]] = []
    for size in sizes:
        frame = icon.resize((size, size), Image.LANCZOS)
        if size >= 256:
            buf = io.BytesIO()
            frame.save(buf, format="PNG", optimize=True)
            frames.append((size, buf.getvalue()))
        else:
            frames.append((size, _dib_frame(frame)))

    offset = 6 + 16 * len(frames)  # ICONDIR(6) + ICONDIRENTRY(16) * n
    entries = bytearray()
    payload = bytearray()
    for size, blob in frames:
        dim = 0 if size >= 256 else size  # 目录里 0 表示 256
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset)
        payload += blob
        offset += len(blob)

    path.write_bytes(struct.pack("<HHH", 0, 1, len(frames)) + bytes(entries) + bytes(payload))


def main() -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    icon = build()

    png = PUBLIC / "icon.png"
    icon.resize((512, 512), Image.LANCZOS).save(png, optimize=True)
    print(f"wrote {png.relative_to(ROOT)}")

    ico = PUBLIC / "icon.ico"
    sizes = [256, 128, 64, 48, 32, 24, 16]
    write_ico(icon, ico, sizes)
    print(f"wrote {ico.relative_to(ROOT)} ({ico.stat().st_size / 1024:.1f} KB)")

    # 桌面快捷方式用另一个文件名。原因：Windows 的 shell 会对"IconLocation 解析失败"
    # 做**按路径**的负缓存（实测：同一个 icon.ico 路径在改好格式后仍然只显示通用图标，
    # 复制成新文件名立刻正常）。换一个文件名即等于换一个缓存键，不会再踩到旧失败记录。
    shortcut_ico = PUBLIC / "app-icon.ico"
    shortcut_ico.write_bytes(ico.read_bytes())
    print(f"wrote {shortcut_ico.relative_to(ROOT)} (快捷方式用，同内容)")


if __name__ == "__main__":
    main()
