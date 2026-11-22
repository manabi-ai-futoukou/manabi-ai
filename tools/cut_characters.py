"""キャラクターシートから立ち絵・表情を切り出し、背景を透過して保存する。

使い方:
    python tools/cut_characters.py [--preview 出力先.png]

入力:
    ../*.png                 元のキャラクターシート（三面図 + 表情3種、白背景）。女子生徒（…-1.png 〜 が s01 〜）
    ../男子生徒/*.png        男子生徒のキャラクターシート（…-1.png 〜 が s11 〜）
    ../先生/*.png            先生のキャラクターシート（ID は sensei）
    assets-src/*.png         追加で生成した表情差分シート（バストアップのみ）
出力:
    src/renderer/public/characters/<id>/*.png  透過 PNG
    src/renderer/public/characters/manifest.json

背景の抜き方:
    白い服（ブラウス・靴下など）が背景と同じ色なので、色だけでは抜けない。
    画像の外周からつながっている白だけを背景とみなす（塗りつぶし方式）。
    バストアップは下端が直線で切られていて線画の輪郭が無いため、
    下端に「せき止め線」を置いて白い服へ背景が流れ込むのを防ぐ。
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

APP_DIR = Path(__file__).resolve().parents[1]
SHEET_DIR = APP_DIR.parent
# シートのフォルダと、ファイル名の番号に足す数（男子生徒は 10 を足して s11 〜 s20 にする）。
# 3 つ目は、そのフォルダのシートに付ける決まった ID（先生）。
SHEET_SOURCES = [(SHEET_DIR, 0, None), (SHEET_DIR / "男子生徒", 10, None), (SHEET_DIR / "先生", 0, "sensei")]
EXTRA_DIR = APP_DIR / "assets-src"
OUT_DIR = APP_DIR / "src" / "renderer" / "public" / "characters"

NEAR_WHITE = 242      # これ以上の明るさ（RGB の最小値）を「白っぽい」とみなす
PURE_BG = 253         # 囲まれた白領域のうち、中央値がこれ以上なら背景の穴とみなす
MIN_FIGURE_AREA = 8000
PAD = 6

# 追加の表情差分シート: ファイル名 -> (キャラクター ID, 表情名を行優先で)
# どのシートも 2 行 × 2 列で、左上から「眠そう・考え中・困り顔・驚き」の順に並んでいる。
EXTRA_LABELS = ["sleepy", "thinking", "troubled", "surprised"]
EXTRA_SHEETS = {
    "sensei_expressions.png": ("sensei", EXTRA_LABELS),
    # 先生は出番が多いので、もう 1 枚ある
    "sensei_expressions2.png": ("sensei", ["wink", "praise", "gentle", "serious"]),
    **{f"s{n:02d}_expressions.png": (f"s{n:02d}", EXTRA_LABELS) for n in range(1, 21)},
    # 画像生成が指定とちがう並びで描いたシート（目で見て確かめた並び）
    "s04_expressions.png": ("s04", ["sleepy", "thinking", "surprised", "troubled"]),
    "s06_expressions.png": ("s06", ["sleepy", "troubled", "surprised", "thinking"]),
}


def character_id(path: Path, offset: int = 0) -> str | None:
    """シートのファイル名からキャラクター ID を決める。"""
    m = re.search(r"-(\d+)$", path.stem)
    return f"s{int(m.group(1)) + offset:02d}" if m else None


def matte(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """背景マスクと、縁のにじみを処理した RGBA 画像を返す。"""
    mn = rgb.min(axis=2).astype(np.int16)
    mx = rgb.max(axis=2).astype(np.int16)
    near = mn >= NEAR_WHITE
    colored = ~near

    # 1) 色の付いた画素を少し太らせて、人物ごとの大まかな範囲を得る
    groups, n = ndimage.label(ndimage.binary_dilation(colored, iterations=6))
    barrier = np.zeros_like(near)
    img_h = rgb.shape[0]
    for idx, sl in enumerate(ndimage.find_objects(groups), start=1):
        comp = colored[sl] & (groups[sl] == idx)
        if comp.sum() < MIN_FIGURE_AREA:
            continue
        ch, cw = comp.shape
        if ch >= 0.6 * img_h:
            continue  # 全身の立ち絵は足元まで輪郭線があるので、せき止め線は不要
        # 列ごとに「いちばん下の色付き画素」を求める。切り口が少し斜めでも追従できる。
        has = comp.any(axis=0)
        lowest = np.where(has, ch - 1 - np.argmax(comp[::-1], axis=0), -1)
        bottom = int(lowest.max())
        on_cut = np.where(lowest >= bottom - 12)[0]
        if len(on_cut) < 0.35 * int(has.sum()):
            continue
        # 白い服の列は切り口に色が無いので、左右の列から切り口の高さを補間してつなぐ
        xs = np.arange(int(on_cut.min()), int(on_cut.max()) + 1)
        cut = np.round(np.interp(xs, on_cut, lowest[on_cut])).astype(int)
        for x, y in zip(xs, cut):
            barrier[sl[0].start + max(0, y - 2): sl[0].start + y + 1, sl[1].start + x] = True

    # 2) 外周からつながる白を背景とする。輪郭線の小さな切れ目から漏れないよう、
    #    いったん 1px 細らせた通路で塗りつぶし、あとで少しだけ戻す。
    passable = near & ~barrier
    core = ndimage.binary_erosion(passable, iterations=1, border_value=1)
    lab, _ = ndimage.label(core)
    edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    bg = np.isin(lab, edge[edge != 0])
    bg = ndimage.binary_dilation(bg, iterations=2, mask=passable)

    # 3) 腕と体のすき間など、囲まれているが背景と同じ純白の領域も背景にする
    holes, hn = ndimage.label(near & ~bg & ~barrier)
    if hn:
        idxs = np.arange(1, hn + 1)
        areas = ndimage.sum(np.ones_like(mn), holes, idxs)
        medians = ndimage.median(mn, holes, idxs)
        for i, area, med in zip(idxs, areas, medians):
            if area >= 200 and med >= PURE_BG:
                bg |= holes == i

    # 4) 縁の処理: 背景に接する明るい灰色（線画と白のにじみ）を半透明にし、
    #    白が混ざった色を元の線の色に戻す（白フチ防止）
    alpha = np.where(bg, 0.0, 1.0)
    eight = np.ones((3, 3), bool)
    ring1 = ndimage.binary_dilation(bg, structure=eight) & ~bg
    ring2 = ndimage.binary_dilation(bg, structure=eight, iterations=2) & ~bg & ~ring1
    grayish = (mx - mn) < 30
    est = np.clip((255 - mn) / 120.0, 0.0, 1.0)
    soft = (ring1 & grayish) | (ring2 & grayish & (mn > 200))
    alpha[soft] = est[soft]

    out = rgb.astype(np.float32)
    part = (alpha > 0.02) & (alpha < 1.0)
    a = alpha[part][:, None]
    out[part] = np.clip((out[part] - (1 - a) * 255.0) / a, 0, 255)
    alpha[alpha <= 0.02] = 0.0
    rgba = np.dstack([out, alpha * 255.0]).astype(np.uint8)
    return bg, rgba


def figures(rgba: np.ndarray, bg: np.ndarray) -> list[dict]:
    """人物ごとに切り出す。小さな飛び地（汗マークなど）は近くの人物にまとめる。"""
    fg = ~bg
    lab, n = ndimage.label(fg, structure=np.ones((3, 3), bool))
    boxes = ndimage.find_objects(lab)
    areas = ndimage.sum(fg, lab, np.arange(1, n + 1))
    big = [i for i in range(n) if areas[i] >= MIN_FIGURE_AREA]
    members: dict[int, list[int]] = {i: [i] for i in big}

    def gap(a, b) -> float:
        dy = max(b[0].start - a[0].stop, a[0].start - b[0].stop, 0)
        dx = max(b[1].start - a[1].stop, a[1].start - b[1].stop, 0)
        return float(np.hypot(dx, dy))

    for i in range(n):
        if i in members or areas[i] < 12:
            continue
        nearest = min(big, key=lambda b: gap(boxes[i], boxes[b]), default=None)
        if nearest is not None and gap(boxes[i], boxes[nearest]) <= 30:
            members[nearest].append(i)

    result = []
    h, w = bg.shape
    for root, ids in members.items():
        y0 = max(min(boxes[i][0].start for i in ids) - PAD, 0)
        y1 = min(max(boxes[i][0].stop for i in ids) + PAD, h)
        x0 = max(min(boxes[i][1].start for i in ids) - PAD, 0)
        x1 = min(max(boxes[i][1].stop for i in ids) + PAD, w)
        crop = rgba[y0:y1, x0:x1].copy()
        keep = np.isin(lab[y0:y1, x0:x1], [i + 1 for i in ids])
        crop[~keep, 3] = 0
        result.append({"box": (x0, y0, x1, y1), "image": crop, "cx": (x0 + x1) / 2, "cy": (y0 + y1) / 2})
    return result


def process(path: Path) -> tuple[list[dict], tuple[int, int]]:
    rgb = np.asarray(Image.open(path).convert("RGB"))
    bg, rgba = matte(rgb)
    return figures(rgba, bg), rgb.shape[:2]


def save(fig: dict, dest: Path) -> dict:
    dest.parent.mkdir(parents=True, exist_ok=True)
    img = Image.fromarray(fig["image"], "RGBA")
    img.save(dest, optimize=True)
    return {"file": dest.name, "width": img.width, "height": img.height}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", type=Path, help="切り抜き結果の一覧画像を書き出す先")
    args = parser.parse_args()

    manifest: dict[str, dict] = {}
    previews: list[tuple[str, np.ndarray]] = []

    sheets = [(sheet, offset, fixed) for folder, offset, fixed in SHEET_SOURCES for sheet in sorted(folder.glob("*.png"))]
    for sheet, offset, fixed in sheets:
        cid = fixed or character_id(sheet, offset)
        if not cid:
            continue
        figs, (h, _) = process(sheet)
        bodies = sorted((f for f in figs if f["box"][3] - f["box"][1] >= 0.6 * h), key=lambda f: f["cx"])
        faces = sorted((f for f in figs if f["box"][3] - f["box"][1] < 0.6 * h), key=lambda f: f["cy"])
        entry = {"source": sheet.name, "full": {}, "faces": {}}
        for name, fig in zip(["front", "side", "back"], bodies):
            entry["full"][name] = save(fig, OUT_DIR / cid / f"full_{name}.png")
        for i, fig in enumerate(faces, start=1):
            entry["faces"][f"face{i}"] = save(fig, OUT_DIR / cid / f"face{i}.png")
            previews.append((f"{cid}/face{i}", fig["image"]))
        if bodies:
            previews.append((f"{cid}/front", bodies[0]["image"]))
        manifest[cid] = entry
        print(f"{cid}: {sheet.name} -> 立ち絵 {len(bodies)} / 表情 {len(faces)}")

    for name, (cid, labels) in EXTRA_SHEETS.items():
        sheet = EXTRA_DIR / name
        if not sheet.exists():
            continue
        figs, (h, _) = process(sheet)
        figs.sort(key=lambda f: (round(f["cy"] / (h / 2)), f["cx"]))
        for label, fig in zip(labels, figs):
            manifest.setdefault(cid, {"full": {}, "faces": {}})["faces"][label] = save(fig, OUT_DIR / cid / f"{label}.png")
            previews.append((f"{cid}/{label}", fig["image"]))
        print(f"{cid}: {name} -> 追加の表情 {len(figs)}")

    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.preview:
        write_preview(previews, args.preview)


def write_preview(items: list[tuple[str, np.ndarray]], dest: Path) -> None:
    """色付きの背景に並べて、抜け残りや欠けを目で確認できるようにする。"""
    cell_w, cell_h, cols = 250, 330, 8
    rows = (len(items) + cols - 1) // cols
    canvas = Image.new("RGB", (cell_w * cols, cell_h * rows), (60, 110, 140))
    for i, (_, arr) in enumerate(items):
        img = Image.fromarray(arr, "RGBA")
        img.thumbnail((cell_w - 10, cell_h - 10), Image.LANCZOS)
        x = (i % cols) * cell_w + (cell_w - img.width) // 2
        y = (i // cols) * cell_h + (cell_h - img.height)
        canvas.paste(img, (x, y), img)
    dest.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(dest)
    print(f"preview: {dest}")


if __name__ == "__main__":
    main()
