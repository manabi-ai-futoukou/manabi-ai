"""画像を一覧（コンタクトシート）にまとめる。人の目で確かめるための道具。

    python tools/contact_sheet.py <一覧.json> <出力フォルダ> [列の数 5] [行の数 4]

一覧.json は [{"file": "画像の場所", "label": "1 行目", "note": "2 行目"}, …]。
出力は sheet-001.jpg, sheet-002.jpg, …（1 枚に 列×行 個ずつ）。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

CELL_W, CELL_H, TEXT_H, GAP = 316, 212, 44, 4


def font(size: int) -> ImageFont.FreeTypeFont:
    for name in ("meiryo.ttc", "YuGothM.ttc", "msgothic.ttc"):
        try:
            return ImageFont.truetype(f"C:/Windows/Fonts/{name}", size)
        except OSError:
            continue
    return ImageFont.load_default()


def fit(text: str, draw: ImageDraw.ImageDraw, face: ImageFont.FreeTypeFont, width: int) -> str:
    while text and draw.textlength(text, font=face) > width:
        text = text[:-1]
    return text


def main() -> None:
    items = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    cols = int(sys.argv[3]) if len(sys.argv) > 3 else 5
    rows = int(sys.argv[4]) if len(sys.argv) > 4 else 4
    per = cols * rows
    bold, small = font(13), font(12)
    for page in range(0, len(items), per):
        chunk = items[page : page + per]
        used_rows = (len(chunk) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * (CELL_W + GAP) + GAP, used_rows * (CELL_H + TEXT_H + GAP) + GAP), "white")
        draw = ImageDraw.Draw(sheet)
        for i, item in enumerate(chunk):
            x = GAP + (i % cols) * (CELL_W + GAP)
            y = GAP + (i // cols) * (CELL_H + TEXT_H + GAP)
            try:
                img = Image.open(item["file"]).convert("RGB")
                img.thumbnail((CELL_W, CELL_H), Image.LANCZOS)
                sheet.paste(img, (x + (CELL_W - img.width) // 2, y + (CELL_H - img.height) // 2))
            except Exception as error:  # 読めない画像は、わけを書いておく
                draw.text((x + 4, y + 4), f"読めません: {error}"[:40], fill="red", font=small)
            draw.text((x + 2, y + CELL_H + 2), fit(f"{page + i + 1}. {item.get('label', '')}", draw, bold, CELL_W - 4), fill="black", font=bold)
            draw.text((x + 2, y + CELL_H + 22), fit(item.get("note", ""), draw, small, CELL_W - 4), fill="#333333", font=small)
        sheet.save(out / f"sheet-{page // per + 1:03d}.jpg", quality=82)
    print(f"{len(items)} 枚を {(len(items) + per - 1) // per} 枚の一覧にしました: {out}")


if __name__ == "__main__":
    main()
