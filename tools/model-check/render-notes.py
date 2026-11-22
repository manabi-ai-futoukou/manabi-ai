# モデルごとの試し（tools/model-check.mjs）に使う、ノートの画像を作る。
#
#   python tools/model-check/render-notes.py <出力フォルダ> [ノートのファイル.json …]
#
# - 見本のノート（good・flawed）: 中学 1 年数学「1-2 数直線と絶対値」のノートを、教科書体の活字で書いたもの。
#   flawed には、わざと誤りを 2 つ入れてある（「−5 は −3 より大きい」「0 の絶対値は 1」）。
# - ノートのファイルを渡すと、その手書きの線をそのまま画像にする（手書きを読む力の試しに使う）。
import json
import os
import sys
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
W, H, SCALE = 1820, 2570, 0.6


def page():
    image = Image.new("RGB", (int(W * SCALE), int(H * SCALE)), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    for y in range(180, H - 100, 70):
        draw.line([(int(120 * SCALE), int(y * SCALE)), (int((W - 120) * SCALE), int(y * SCALE))], fill=(215, 222, 232), width=1)
    return image, draw


FONT = r"C:\Windows\Fonts\UDDigiKyokashoN-R.ttc"
GOOD = """1-2 数直線と絶対値
・数直線…まっすぐな線の上に数をならべたもの。
　右へいくほど大きい。0 が原点。
・負の数は 0 より左。 −5 は −3 より左にあるから
　−5 ＜ −3 （−5 のほうが小さい）
　→ 気温でいうと −5℃ のほうが寒い！
・絶対値＝原点からのきょり。向きは考えない。
　|−4| = 4,  |+4| = 4,  |0| = 0
・自分のことば: 絶対値は「0 から何歩はなれているか」。
　借金 300 円と 貯金 300 円は、絶対値は同じ 300。
・まちがえやすい: 負の数は、絶対値が大きいほど
　数としては小さい。 −7 ＜ −2 だけど |−7| ＞ |−2|
・問題: 絶対値が 3 より小さい整数
　→ −2, −1, 0, 1, 2 の 5 つ"""
FLAWED = """1-2 数直線と絶対値
・数直線は、直線の上に数を対応させたものです。
・0 を表す点を原点といいます。
・右へいくほど数は大きくなります。
・−5 は −3 より大きい。（5 のほうが 3 より大きいから）
・絶対値は、原点からのきょりのことです。
　|−4| = 4,  |+4| = 4,  |0| = 1
・絶対値が 3 より小さい整数
　→ 1, 2"""


def typed(name, text):
    image, draw = page()
    font = ImageFont.truetype(FONT, int(58 * SCALE))
    y = 185
    for line in text.split("\n"):
        draw.text((int(150 * SCALE), int((y - 62) * SCALE)), line, font=font, fill=(35, 35, 43))
        y += 140
    image.save(os.path.join(out, name))


typed("note-good.png", GOOD)
typed("note-flawed.png", FLAWED)

for path in sys.argv[2:]:
    notebook = json.load(open(path, encoding="utf-8"))
    for index, p in enumerate(notebook["pages"]):
        strokes = p.get("strokes") or []
        if len(strokes) < 20:
            continue
        image, draw = page()
        for stroke in strokes:
            points = [(x * SCALE, y * SCALE) for x, y, *_ in stroke["points"]]
            width = max(2, int(stroke.get("size", 9) * SCALE * 0.6))
            if len(points) == 1:
                x, y = points[0]
                draw.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2], fill=stroke.get("color", "#23232b"))
            else:
                draw.line(points, fill=stroke.get("color", "#23232b"), width=width, joint="curve")
        name = f"handwriting-{index + 1}.png"
        image.save(os.path.join(out, name))
        print(name, len(strokes))
print("ok")
