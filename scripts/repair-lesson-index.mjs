// 授業の「点検済み」の記録（lessons-index.json）に、記録がもれている授業を補う。
//
//   node scripts/repair-lesson-index.mjs          何件もれているかを数えるだけ
//   node scripts/repair-lesson-index.mjs --write  もれている授業を「点検済み」として記録する
//
// 2026-11-16 に、授業のファイルは 3,715 件あるのに、記録は 84 件しか残っていないことが分かった
// （まとめて作っていた間の記録が、ファイルに書かれていなかった）。その間は「作った授業をもう一度 AI に点検させる」設定で
// 動かしていたので、もれている授業は点検済みとして補う。
// 必ず、アプリを閉じてから実行する（アプリは記録を覚えたまま動いているので、開いている間に直しても上書きされる）。
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const write = process.argv.includes('--write')
const dataDir = process.env.MANABI_DATA_DIR || join(process.env.APPDATA, '学びアイ', 'data')
const indexFile = join(dataDir, 'lessons-index.json')
const lessonsDir = join(dataDir, 'lessons')

const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : {}
const keys = readdirSync(lessonsDir).filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3))
const missing = keys.filter((key) => !index[key])
console.log(`授業 ${keys.length} 件、記録 ${Object.keys(index).length} 件、もれ ${missing.length} 件`)

if (write && missing.length) {
  for (const key of missing) index[key] = { at: Math.round(statSync(join(lessonsDir, `${key}.md`)).mtimeMs), reviewed: true }
  writeFileSync(`${indexFile}.tmp`, JSON.stringify(index), 'utf8')
  renameSync(`${indexFile}.tmp`, indexFile)
  console.log(`${missing.length} 件を「点検済み」として記録しました。`)
}
