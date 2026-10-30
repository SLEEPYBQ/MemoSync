"""Turn generated character drafts into web-ready transparent WebP.

  python3 site/scripts/process-art.py [name ...]

The drafts (generated character art in site/art/drafts/) are working files and
are not committed; only the processed WebP files in site/public/art/ are.

For every entry in PICKS: remove the white background (flood fill from the
border, so white *inside* an outline - the cat's body - stays opaque), crop to
the subject, and export a 2x WebP. Heads (`head=` color) get their hand-drawn
fill replaced with a mathematically round, antialiased circle of the same
colour, so every head is a true circle at any size.
"""
from __future__ import annotations

import subprocess
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
DRAFTS = ROOT / "art" / "drafts"
OUT = ROOT / "public" / "art"

# name in the site -> (draft file, head fill colour or None)
PICKS: dict[str, tuple[str, tuple[int, int, int] | None]] = {}


def pick(name: str, draft: str, head: tuple[int, int, int] | None = None) -> None:
    PICKS[name] = (draft, head)


HEAD_FRACTION = 0.76
LAVENDER = (226, 220, 248)
SAGE = (196, 210, 178)

for mood in ("neutral", "happy", "thinking", "wink", "surprised"):
    pick(f"ben-{mood}", f"ben-{mood}-v1.png", LAVENDER)
pick("cat-perch", "cat-perch-v1.png")
pick("cat-tug", "cat-tug-v1.png")
for mood in ("neutral", "thinking", "blank", "happy"):
    pick(f"agent-{mood}", f"agent-{mood}-v1.png", SAGE)
for pose, v in {"hop": 1, "carry-card": 1, "sleep-card": 1, "stamp": 2, "magnifier": 1,
                "point": 1, "stretch": 2, "sit": 1}.items():
    pick(f"cat-{pose}", f"cat-{pose}-v{v}.png")
for prop, v in {"paper-ball": 2}.items():
    pick(f"prop-{prop}", f"prop-{prop}-v{v}.png")


def near_white(px: np.ndarray) -> np.ndarray:
    lo = px.min(axis=-1).astype(int)
    hi = px.max(axis=-1).astype(int)
    return (lo >= 232) & (hi - lo <= 14)


def background_mask(rgb: np.ndarray) -> np.ndarray:
    """True where a pixel is near-white AND connected to the image border."""
    h, w, _ = rgb.shape
    white = near_white(rgb)
    seen = np.zeros((h, w), bool)
    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            if white[y, x] and not seen[y, x]:
                seen[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if white[y, x] and not seen[y, x]:
                seen[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx] and white[ny, nx]:
                seen[ny, nx] = True
                q.append((ny, nx))
    return seen


def soften_edge(alpha: np.ndarray, rgb: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """Antialias: subject pixels touching the background get partial alpha by lightness."""
    a = alpha.astype(float)
    pad = np.pad(bg, 1)
    touching = (pad[:-2, 1:-1] | pad[2:, 1:-1] | pad[1:-1, :-2] | pad[1:-1, 2:]) & ~bg
    light = rgb.min(axis=-1).astype(float)
    # The darker the edge pixel, the more of it is line: keep it.
    edge_alpha = np.clip((255 - light) / 120.0, 0.0, 1.0) * 255
    a[touching] = np.maximum(edge_alpha[touching], 40)
    return a.astype(np.uint8)


def round_head(img: Image.Image, color: tuple[int, int, int]) -> Image.Image:
    """Replace the drawn head fill with a true antialiased circle of the same colour."""
    px = np.asarray(img).astype(int)
    rgb, a = px[..., :3], px[..., 3]
    dist = np.abs(rgb - np.array(color)).sum(axis=-1)
    fill = (dist < 60) & (a > 0)
    ys, xs = np.nonzero(fill)
    if len(xs) < 1000:
        raise SystemExit("head fill colour not found; check the colour")
    # Fit the circle on the fill's *bounding extent* inside the main blob:
    # area-equivalent radius is robust to features punched into the fill.
    cy, cx = ys.mean(), xs.mean()
    holes = 0
    r = np.sqrt((len(xs) + holes) / np.pi)
    # Features (eyes, mouth) sit inside the circle and are not "fill": grow r
    # until the circle covers the fill's own extent along both axes.
    r = max(r, (xs.max() - xs.min()) / 2, (ys.max() - ys.min()) / 2)
    cx = (xs.max() + xs.min()) / 2
    cy = (ys.max() + ys.min()) / 2

    h, w = a.shape
    scale = 4
    disk = Image.new("L", (w * scale, h * scale), 0)
    ImageDraw.Draw(disk).ellipse(
        [(cx - r) * scale, (cy - r) * scale, (cx + r) * scale, (cy + r) * scale], fill=255
    )
    disk = np.asarray(disk.resize((w, h), Image.LANCZOS)).astype(int)

    out = px.copy()
    # Remove the hand-drawn fill everywhere; keep lines, mouth, antenna.
    out[fill, 3] = 0
    layer = Image.fromarray(out.astype(np.uint8), "RGBA")
    base = np.zeros_like(px)
    base[..., :3] = color
    base[..., 3] = disk
    base_img = Image.fromarray(base.astype(np.uint8), "RGBA")
    out_img = Image.alpha_composite(base_img, layer)
    # Every head ships on the same square canvas: centred on the circle, whose
    # diameter is HEAD_FRACTION of the width, so heads line up at any size.
    side = round(2 * r / HEAD_FRACTION)
    left, top = round(cx - side / 2), round(cy - side / 2)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(out_img.crop((max(left, 0), max(top, 0), min(left + side, w), min(top + side, h))),
                           (max(-left, 0), max(-top, 0)))
    return canvas


def process(name: str, draft: str, head: tuple[int, int, int] | None) -> None:
    src = Image.open(DRAFTS / draft).convert("RGB")
    rgb = np.asarray(src)
    bg = background_mask(rgb)
    alpha = np.where(bg, 0, 255).astype(np.uint8)
    alpha = soften_edge(alpha, rgb, bg)
    img = Image.fromarray(np.dstack([rgb, alpha]), "RGBA")
    if head:
        img = round_head(img, head)
        bbox = (0, 0, img.width, img.height)
    else:
        bbox = img.getbbox()
    assert bbox, name
    pad = 0 if head else 12
    img = img.crop((max(bbox[0] - pad, 0), max(bbox[1] - pad, 0),
                    min(bbox[2] + pad, img.width), min(bbox[3] + pad, img.height)))
    longest = max(img.size)
    if longest > 900:
        f = 900 / longest
        img = img.resize((round(img.width * f), round(img.height * f)), Image.LANCZOS)
    OUT.mkdir(parents=True, exist_ok=True)
    png = OUT / f"{name}.png"
    img.save(png)
    subprocess.run(["cwebp", "-quiet", "-q", "90", "-alpha_q", "100", str(png), "-o", str(OUT / f"{name}.webp")], check=True)
    png.unlink()
    print(f"{name:20s} {img.size[0]}x{img.size[1]}")


if __name__ == "__main__":
    import sys
    only = set(sys.argv[1:])
    for name, (draft, head) in PICKS.items():
        if only and name not in only:
            continue
        if not (DRAFTS / draft).exists():
            print(f"{name:20s} missing {draft}")
            continue
        process(name, draft, head)
