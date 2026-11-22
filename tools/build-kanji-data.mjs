// 漢字特訓モードで使うデータ（resources/kanji/kanji.json.gz）を、公開されている 2 つの資料から作る。
//
//   node tools/build-kanji-data.mjs <資料を置いたフォルダ>
//
// フォルダには、次の 2 つを置く。
//   kanjivg.xml.gz    … KanjiVG（書き順つきの字形）。https://github.com/KanjiVG/kanjivg/releases の kanjivg-YYYYMMDD.xml.gz
//                        © Ulrich Apel ほか。CC BY-SA 3.0
//   kanjidic2.xml.gz  … KANJIDIC2（読み、学年、画数）。http://www.edrdg.org/kanjidic/kanjidic2.xml.gz
//                        © Electronic Dictionary Research and Development Group。CC BY-SA 4.0
//
// できあがるデータは、この 2 つを組み合わせて形を変えたものなので、同じく CC BY-SA 4.0 で配布する（resources/kanji/NOTICE.md）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

const source = process.argv[2]
if (!source) throw new Error('資料を置いたフォルダを指定してください。')
const outDir = resolve(import.meta.dirname, '..', 'resources', 'kanji')
mkdirSync(outDir, { recursive: true })

const read = (name) => gunzipSync(readFileSync(join(source, name))).toString('utf8')
const isKanji = (code) => (code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0x20000 && code <= 0x3ffff)

// ───────── KanjiVG: 1 字ごとの、書き順どおりに並んだ線 ─────────
const strokes = new Map()
const vg = read('kanjivg.xml.gz')
const generated = /This file was generated on (\d{4}-\d{2}-\d{2})/.exec(vg)?.[1] ?? ''
for (const block of vg.matchAll(/<kanji id="kvg:kanji_([0-9a-f]+)">([\s\S]*?)<\/kanji>/g)) {
  const code = parseInt(block[1], 16)
  if (!isKanji(code)) continue
  const paths = [...block[2].matchAll(/<path [^>]*\bd="([^"]+)"/g)].map((m) => m[1].replace(/\s+/g, ' ').trim())
  // 線の書き方に使える文字だけでできていることを確かめる（念のため）
  if (paths.length && paths.every((d) => /^[MmLlHhVvCcSsQqTtAaZz0-9.,\- ]+$/.test(d))) strokes.set(String.fromCodePoint(code), paths)
}

// ───────── KANJIDIC2: 読み、学年、よく使われる順位 ─────────
const entries = {}
const dic = read('kanjidic2.xml.gz')
const version = /<database_version>([^<]+)</.exec(dic)?.[1] ?? ''
const decode = (text) => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
for (const block of dic.matchAll(/<character>([\s\S]*?)<\/character>/g)) {
  const body = block[1]
  const char = /<literal>([^<]+)<\/literal>/.exec(body)?.[1]
  const d = char && strokes.get(char)
  if (!d) continue
  const readings = (type) => [...body.matchAll(new RegExp(`<reading r_type="${type}">([^<]+)</reading>`, 'g'))].map((m) => decode(m[1]))
  entries[char] = {
    // 学年: 1〜6 = 小学校で習う / 8 = そのほかの常用漢字 / 9・10 = 人名用漢字 / 0 = それ以外
    g: Number(/<grade>(\d+)<\/grade>/.exec(body)?.[1] ?? 0),
    // 新聞でよく使われる順位（1 がいちばん多い。順位が無いものは 0）
    f: Number(/<freq>(\d+)<\/freq>/.exec(body)?.[1] ?? 0),
    on: readings('ja_on'),
    kun: readings('ja_kun'),
    d,
  }
}

const byGrade = {}
for (const e of Object.values(entries)) byGrade[e.g] = (byGrade[e.g] ?? 0) + 1
const json = JSON.stringify({ kanjivg: generated, kanjidic2: version, kanji: entries })
writeFileSync(join(outDir, 'kanji.json.gz'), gzipSync(json, { level: 9 }))
writeFileSync(
  join(outDir, 'NOTICE.md'),
  `# 漢字データについて

\`kanji.json.gz\` は、次の 2 つの資料を組み合わせ、アプリで使いやすい形に変えたものです（作り方: \`tools/build-kanji-data.mjs\`）。

| 資料 | 内容 | 著作権者 | ライセンス |
| --- | --- | --- | --- |
| [KanjiVG](https://kanjivg.tagaini.net/)（${generated} 版） | 書き順つきの字形 | Ulrich Apel ほか | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| [KANJIDIC2](https://www.edrdg.org/wiki/index.php/KANJIDIC_Project)（${version}） | 読み、学年、使用頻度 | Electronic Dictionary Research and Development Group | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |

このデータ（\`kanji.json.gz\`）は、[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) で配布します。
アプリを配布するときは、この文書を同梱し、アプリの中でも上の 2 つの資料を使っていることを表示してください（漢字特訓の画面に表示があります）。
アプリのプログラムそのものは、このライセンスの対象ではありません。

収録: ${Object.keys(entries).length} 字（小学校 ${[1, 2, 3, 4, 5, 6].map((g) => byGrade[g] ?? 0).join(' + ')} 字、そのほかの常用漢字 ${byGrade[8] ?? 0} 字、人名用漢字 ${(byGrade[9] ?? 0) + (byGrade[10] ?? 0)} 字、それ以外 ${byGrade[0] ?? 0} 字）
`,
)
console.log(`${Object.keys(entries).length} 字を書き出しました（${Math.round(json.length / 1024)} KB → 圧縮後 ${Math.round(gzipSync(json, { level: 9 }).length / 1024)} KB）`)
console.log('学年ごとの字数:', byGrade)
console.log('KanjiVG にあって KANJIDIC2 に無い字:', [...strokes.keys()].filter((c) => !entries[c]).length)
