// 第三者の素材と部品の表示（THIRD_PARTY_NOTICES.md）を作る。
//
//   node --no-warnings tools/build-notices.mjs
//
// 学びアイのうち、自分たちで作ったもの（プログラム・授業の文章・AI で作った挿絵と人物の絵）は MIT ライセンス（LICENSE）。
// それ以外（漢字のデータ、資料の画像、組みこんだ部品など）は、元のライセンスのままで、この文書に出どころと条件を書く。
// - 資料の画像は、教材の置き場の media/media.json（kind が public のもの）から読む
// - 部品は、package.json の dependencies から、実際に入っているもの（node_modules）をたどって読む
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const cell = (text) => String(text ?? '').replace(/\|/g, '｜').replace(/\s+/g, ' ').trim()

// ───────── 部品（npm） ─────────
const pkg = readJson(join(root, 'package.json'))
const seen = new Map()
const visit = (name, from) => {
  // 入れ子の node_modules を先に探し、無ければ、いちばん上のものを使う
  const dir = [join(from, 'node_modules', name), join(root, 'node_modules', name)].find((d) => existsSync(join(d, 'package.json')))
  if (!dir) return
  const meta = readJson(join(dir, 'package.json'))
  const key = `${meta.name}@${meta.version}`
  if (seen.has(key)) return
  const repo = typeof meta.repository === 'string' ? meta.repository : (meta.repository?.url ?? '')
  seen.set(key, { name: meta.name, version: meta.version, license: typeof meta.license === 'string' ? meta.license : (meta.license?.type ?? (meta.licenses ?? []).map((l) => l.type).join(' / ')), url: repo.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '') || meta.homepage || '' })
  for (const dep of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) visit(dep, dir)
}
for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, root)
// Electron（アプリの土台）は、配るものに入るので、ここにも書く
visit('electron', root)
const parts = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
const byLicense = {}
for (const part of parts) byLicense[part.license || '不明'] = (byLicense[part.license || '不明'] ?? 0) + 1

// ───────── 資料の画像 ─────────
const media = readJson(join(dataDir, 'media', 'media.json'), { pictures: {}, people: {} })
const publicPictures = Object.entries(media.pictures ?? {}).filter(([, p]) => p.kind === 'public')
const groups = new Map()
for (const [id, p] of publicPictures) {
  const license = p.license || '不明'
  if (!groups.has(license)) groups.set(license, [])
  groups.get(license).push({ id, ...p })
}
const order = (license) => (/^CC BY/.test(license) ? 0 : license === 'CC0' ? 1 : 2)
const licenses = [...groups.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b))
const generated = Object.values(media.pictures ?? {}).filter((p) => p.kind === 'generated').length + Object.values(media.people ?? {}).filter((p) => p.kind === 'generated').length

const lines = []
const push = (...text) => lines.push(...text)
push(
  '# 第三者の素材と部品について（THIRD_PARTY_NOTICES）',
  '',
  '学びアイのうち、自分たちで作ったもの（プログラム、授業の文章、用語集、記述・論述の問題、AI で作った挿絵と人物の絵）は、[MIT ライセンス](LICENSE)で公開しています。',
  '',
  '**次のものは、MIT ライセンスの対象ではありません。それぞれ、元のライセンスのままで入っています。** 使い直す（配り直す・作りかえる）ときは、それぞれの条件に従ってください。',
  '',
  'この文書は `tools/build-notices.mjs` で作っています（手で直さず、道具を動かし直してください）。',
  '',
  '## 1. 漢字のデータ（CC BY-SA 4.0）',
  '',
  '漢字特訓で使う `resources/kanji/kanji.json.gz` は、次の 2 つの資料を組み合わせて作ったものです。くわしくは [`resources/kanji/NOTICE.md`](resources/kanji/NOTICE.md) を見てください。',
  '',
  '| 資料 | 内容 | 著作権者 | ライセンス |',
  '| --- | --- | --- | --- |',
  '| [KanjiVG](https://kanjivg.tagaini.net/) | 書き順つきの字形 | Ulrich Apel ほか | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |',
  '| [KANJIDIC2](https://www.edrdg.org/wiki/index.php/KANJIDIC_Project) | 読み、学年、使用頻度 | Electronic Dictionary Research and Development Group | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |',
  '',
  `## 2. 授業の資料の画像（${publicPictures.length} 点）`,
  '',
  '授業の中の写真・絵・地図・文書などの資料の画像は、[Wikimedia Commons](https://commons.wikimedia.org/) から、使ってよいと確かめられたものだけを取り寄せています。',
  '画像ごとの出どころとライセンスは、下の表のとおりです（アプリの中でも、画像の下に表示しています）。「もとのページ」に、作者・ライセンスの原文があります。',
  '',
  `AI で作った挿絵と人物の絵（${generated} 点）は、この表には入りません（MIT ライセンスの側です）。`,
  '',
)
for (const license of licenses) {
  const rows = groups.get(license).sort((a, b) => a.id.localeCompare(b.id))
  push(`### ${license}（${rows.length} 点）`, '', '| 授業の中の ID | ファイル | 表示（クレジット） | 根拠 | もとのページ |', '| --- | --- | --- | --- | --- |')
  for (const row of rows) push(`| ${cell(row.id)} | ${cell(row.file)} | ${cell(row.credit)} | ${cell(row.basis)} | ${row.source ? `[開く](${row.source})` : ''} |`)
  push('')
}
push(
  '## 3. アプリに組みこんだ部品',
  '',
  `配るもの（Windows 版のインストーラー、Web 版）に入る部品は、${parts.length} 個です（ライセンスの内わけ: ${Object.entries(byLicense).map(([l, n]) => `${l} ${n}`).join('、')}）。`,
  'それぞれのライセンスの全文は、部品のフォルダー（`node_modules/<名前>/`）の中の LICENSE にあります。',
  'Electron に入っている Chromium などの部品のライセンスは、インストールしたフォルダーの `LICENSES.chromium.html` にあります。',
  '数式の表示（KaTeX）には、KaTeX のフォント（SIL Open Font License 1.1）がふくまれます。',
  '',
  '| 部品 | 版 | ライセンス | 出どころ |',
  '| --- | --- | --- | --- |',
)
for (const part of parts) push(`| ${cell(part.name)} | ${cell(part.version)} | ${cell(part.license)} | ${cell(part.url)} |`)
push(
  '',
  '## 4. 使うときに取り寄せるもの（配るものには入っていません）',
  '',
  '| もの | 使うところ | ライセンス | 出どころ |',
  '| --- | --- | --- | --- |',
  '| whisper.cpp（エンジン） | 英会話の音声認識（はじめて使うときに、利用者の PC に取り寄せます） | MIT | https://github.com/ggml-org/whisper.cpp |',
  '| Whisper の音声モデル | 同上 | MIT | https://huggingface.co/ggerganov/whisper.cpp |',
  '',
  '## 5. 声',
  '',
  '動画（試作）のせりふの声は、[AivisSpeech](https://aivis-project.com/) の標準の音声モデル「まお」で作ったものです（ACML 1.0）。英会話の読み上げは、利用者の端末に入っている音声（Windows・ブラウザーのもの）を使います。',
  '',
  '## 6. 名前と商標',
  '',
  'ChatGPT・OpenAI は OpenAI の、Claude・Anthropic は Anthropic の、Windows は Microsoft の商標です。学びアイは、これらの会社が作ったり、認めたりしたものではありません。',
  '',
)
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), lines.join('\n'), 'utf8')
console.log(`THIRD_PARTY_NOTICES.md を作りました（資料の画像 ${publicPictures.length} 点・部品 ${parts.length} 個）`)
console.log(`部品のライセンス: ${JSON.stringify(byLicense)}`)
