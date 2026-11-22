"""生成した絵を、アプリで表示する大きさ・形式に整える（scripts/install-media.mjs から呼ばれる）。

    python tools/convert_media.py person <元の画像> <出力.jpg>   人物の絵: 顔のまわりを正方形に切り出して 320 画素に
    python tools/convert_media.py scene  <元の画像> <出力.jpg>   挿絵: 横 1200 画素に
"""
from __future__ import annotations

import sys

import numpy as np
from PIL import Image


def person(src: str, dst: str) -> None:
    img = Image.open(src).convert("RGB")
    w, h = img.size
    # 白でない所（人物）の範囲から、顔のあるあたり（上から 6 割）を正方形に切り出す
    ink = np.asarray(img).min(axis=2) < 242
    rows = np.where(ink.any(axis=1))[0]
    cols = np.where(ink.any(axis=0))[0]
    top = int(rows[0]) if len(rows) else 0
    center = int((cols[0] + cols[-1]) / 2) if len(cols) else w // 2
    side = int(min(w, h) * 0.6)
    left = max(0, min(w - side, center - side // 2))
    top = max(0, min(h - side, top - int(h * 0.02)))
    img.crop((left, top, left + side, top + side)).resize((320, 320), Image.LANCZOS).save(dst, quality=90)


def scene(src: str, dst: str) -> None:
    img = Image.open(src).convert("RGB")
    if img.width > 1200:
        img = img.resize((1200, round(img.height * 1200 / img.width)), Image.LANCZOS)
    img.save(dst, quality=84, optimize=True)


if __name__ == "__main__":
    mode, source, target = sys.argv[1:4]
    (person if mode == "person" else scene)(source, target)
