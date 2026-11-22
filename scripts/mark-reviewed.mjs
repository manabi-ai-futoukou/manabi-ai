// 授業を精査した記録を残す。アプリは、この記録がある授業に「精査済み」と表示する。
//
//   node scripts/mark-reviewed.mjs <授業のキー> ok   ["メモ"]     直すところが無かった
//   node scripts/mark-reviewed.mjs <授業のキー> fixed "直した点"  本文を直した
//   node scripts/mark-reviewed.mjs <授業のキー> flag  "理由"      自分では直せない・人に確かめてほしい点がある
//
// 授業のキーは、ファイル名から .md を除いたもの（例: jhs2-math-1-1、es3-math-2-4.deep）。
// 記録は、授業の本文と同じフォルダに <キー>.review.json として置く（アプリが持つ管理ファイルには触れない）。
// 精査した人の名前は、環境変数 MANABI_REVIEWER で変えられる（既定は codex）。
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [key, verdict, ...rest] = process.argv.slice(2)
const dir = join(process.env.MANABI_DATA_DIR || join(process.env.APPDATA, '学びアイ', 'data'), 'lessons')

if (!key || !['ok', 'fixed', 'flag'].includes(verdict)) {
  console.error('使い方: node scripts/mark-reviewed.mjs <授業のキー> ok|fixed|flag ["メモ"]')
  process.exit(2)
}
if (!/^[A-Za-z0-9_.-]+$/.test(key) || !existsSync(join(dir, `${key}.md`))) {
  console.error(`授業が見つかりません: ${key}`)
  process.exit(2)
}
if (verdict !== 'ok' && !rest.join(' ').trim()) {
  console.error('fixed と flag には、直した点や理由のメモが必要です。')
  process.exit(2)
}
const record = { by: process.env.MANABI_REVIEWER || 'codex', at: Date.now(), verdict, note: rest.join(' ').trim() }
writeFileSync(join(dir, `${key}.review.json`), JSON.stringify(record), 'utf8')
console.log(`記録しました: ${key} ${verdict}`)
