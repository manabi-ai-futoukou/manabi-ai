# 漢字データについて

`kanji.json.gz` は、次の 2 つの資料を組み合わせ、アプリで使いやすい形に変えたものです（作り方: `tools/build-kanji-data.mjs`）。

| 資料 | 内容 | 著作権者 | ライセンス |
| --- | --- | --- | --- |
| [KanjiVG](https://kanjivg.tagaini.net/)（2026-07-14 版） | 書き順つきの字形 | Ulrich Apel ほか | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| [KANJIDIC2](https://www.edrdg.org/wiki/index.php/KANJIDIC_Project)（2026-319） | 読み、学年、使用頻度 | Electronic Dictionary Research and Development Group | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |

このデータ（`kanji.json.gz`）は、[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) で配布します。
アプリを配布するときは、この文書を同梱し、アプリの中でも上の 2 つの資料を使っていることを表示してください（漢字特訓の画面に表示があります）。
アプリのプログラムそのものは、このライセンスの対象ではありません。

収録: 6417 字（小学校 80 + 160 + 200 + 202 + 193 + 191 字、そのほかの常用漢字 1110 字、人名用漢字 774 字、それ以外 3507 字）
