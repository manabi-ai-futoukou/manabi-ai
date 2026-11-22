// 目で確かめるための一覧（コンタクトシート）を作る。まだ見ていないものだけを並べる。
//   node tools/review-list.mjs scenes     挿絵（assets-src/media/lessons）
//   node tools/review-list.mjs materials  資料画像（assets-src/media/public/items。権利の点検を通ったもの）
//   --mark を付けると、いま並べたものを「見た」として記録する（assets-src/media/reviewed.json）
// 一覧の画像は .try/review/<種類>/ に出る。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const media = join(root, 'assets-src', 'media')
const kind = process.argv[2]
const mark = process.argv.includes('--mark')
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
const order = (a, b) => a.localeCompare(b, 'ja', { numeric: true })
const reviewedFile = join(media, 'reviewed.json')
const reviewed = readJson(reviewedFile) ?? { scenes: [], materials: [] }
const seen = new Set(reviewed[kind] ?? [])

const out = join(root, '.try', 'review', kind)
// --mark は、前に並べた一覧（list.json）にあるものだけを「見た」とする（そのあとにできた画像は、まだ見ていない）
if (mark) {
  const listed = (readJson(join(out, 'list.json')) ?? []).map((i) => i.key).filter((key) => existsSync(kind === 'scenes' ? join(media, 'lessons', `${key}.png`) : join(media, 'public', 'items', `${key}.json`)))
  reviewed[kind] = [...new Set([...seen, ...listed])]
  writeFileSync(reviewedFile, JSON.stringify(reviewed), 'utf8')
  console.log(`「見た」と記録しました: ${listed.length} 件（合わせて ${reviewed[kind].length} 件）`)
  process.exit(0)
}

let items = []
if (kind === 'scenes') {
  const dir = join(media, 'lessons')
  for (const key of readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)).sort(order)) {
    const info = readJson(join(dir, `${key}.json`))
    const check = readJson(join(dir, `${key}.check.json`))
    if (!info || !check || check.ok === false || seen.has(key)) continue
    items.push({ key, file: join(dir, `${key}.png`), label: key, note: info.caption })
  }
} else if (kind === 'materials') {
  const dir = join(media, 'public', 'items')
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort(order)) {
    const item = readJson(join(dir, `${name}.json`))
    if (!item || item.status !== '取り寄せた' || item.audit?.ok !== true || !existsSync(item.file) || seen.has(name)) continue
    items.push({ key: name, file: item.file, label: `${name} ${item.caption}`, note: `${item.audit.class}｜${String(item.source.title).replace(/^File:/, '')}` })
  }
} else {
  throw new Error('scenes か materials を指定します')
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'list.json'), JSON.stringify(items), 'utf8')
if (items.length) {
  const made = spawnSync('python', [join(root, 'tools', 'contact_sheet.py'), join(out, 'list.json'), out], { encoding: 'utf8' })
  console.log((made.stdout + made.stderr).trim())
} else console.log('新しく見るものはありません')
