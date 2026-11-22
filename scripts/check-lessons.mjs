// AI が作った授業の本文を機械的に検査する（書式・数式・図のブロック）。内容の正しさは見ない。
//
//   node scripts/check-lessons.mjs                 すべての授業
//   node scripts/check-lessons.mjs jhs2-math       ID がこの文字で始まる授業だけ
//   node scripts/check-lessons.mjs jhs2-math --json  結果を JSON で出す
//
// 授業の置き場所は %APPDATA%\学びアイ\data\lessons。別の場所を調べるときは MANABI_DATA_DIR で指定する。
// 「誤り」が 1 つでもあれば、終了コード 1 で終わる。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checkLesson } from './lib/check-lesson.mjs'

const prefix = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? ''
const asJson = process.argv.includes('--json')
const dir = join(process.env.MANABI_DATA_DIR || join(process.env.APPDATA, '学びアイ', 'data'), 'lessons')

const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f.startsWith(prefix)).sort()
const report = []
for (const file of files) {
  const found = checkLesson(readFileSync(join(dir, file), 'utf8'))
  if (found.length) report.push({ lesson: file.replace(/\.md$/, ''), found })
}
const errors = report.flatMap((r) => r.found).filter((f) => f.level === 'error').length
const warnings = report.flatMap((r) => r.found).length - errors

if (asJson) console.log(JSON.stringify({ checked: files.length, errors, warnings, report }, null, 1))
else {
  for (const { lesson, found } of report) {
    console.log(lesson)
    for (const f of found) console.log(`  ${f.level === 'error' ? '誤り' : '注意'}: ${f.message}`)
  }
  console.log(`\n${files.length} 件を調べました。誤り ${errors} 件、注意 ${warnings} 件（${report.length} 件の授業）。`)
}
process.exit(errors ? 1 : 0)
