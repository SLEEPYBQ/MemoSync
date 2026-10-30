"""Measure each cat drawing's head size by the distance between its two pink
inner ears, so every frame can be shown at the same head size.

  python3 site/scripts/cat-scale.py <png> [...]
prints `name  ear_distance  ears_y`.
"""
import sys
from collections import deque

import numpy as np
from PIL import Image


def pink_blobs(path: str):
    px = np.asarray(Image.open(path).convert("RGB")).astype(int)
    r, g, b = px[..., 0], px[..., 1], px[..., 2]
    pink = (r > 200) & (g > 110) & (g < 200) & (b > 110) & (b < 200) & (r - g > 35)
    h, w = pink.shape
    seen = np.zeros_like(pink)
    blobs = []
    for y0, x0 in zip(*np.nonzero(pink)):
        if seen[y0, x0]:
            continue
        q = deque([(y0, x0)])
        seen[y0, x0] = True
        pts = []
        while q:
            y, x = q.popleft()
            pts.append((y, x))
            for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= ny < h and 0 <= nx < w and pink[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        if len(pts) > 40:
            ys, xs = zip(*pts)
            blobs.append((len(pts), float(np.mean(xs)), float(np.mean(ys))))
    return sorted(blobs, reverse=True)


for path in sys.argv[1:]:
    blobs = pink_blobs(path)
    # The ears are the two biggest pink areas that sit side by side at similar height.
    ears = None
    for i in range(min(4, len(blobs))):
        for j in range(i + 1, min(5, len(blobs))):
            a, b = blobs[i], blobs[j]
            if abs(a[2] - b[2]) < 0.25 * abs(a[1] - b[1]) + 30:
                ears = (a, b)
                break
        if ears:
            break
    if not ears:
        print(f"{path}\tno ears found ({len(blobs)} pink blobs)")
        continue
    a, b = ears
    d = float(np.hypot(a[1] - b[1], a[2] - b[2]))
    print(f"{path.split('/')[-1]}\t{d:.1f}\t{(a[2]+b[2])/2:.0f}")
