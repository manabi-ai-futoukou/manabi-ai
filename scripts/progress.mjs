// 教材づくり（掛け合い・動く図解）と、画像の生成の進み具合を、ファイルから数えて表示する。
//   node scripts/progress.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const data = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const index = JSON.parse(readFileSync(join(data, 'lessons-index.json'), 'utf8'))
const keys = Object.keys(index)
const files = readdirSync(join(data, 'lessons')).filter((f) => f.endsWith('.md')).length
const count = (test) => keys.filter((k) => test(index[k])).length
const of = (prefixes, test) => keys.filter((k) => prefixes.some((p) => k.startsWith(`${p}-`)) && test(index[k])).length
const history = ['jhs-history', 'es6-social', 'hs-rekishi-sogo', 'hs-nihonshi', 'hs-sekaishi', 'hs-rinri']
const lines = [
  `授業の本文 ${files} 件（記録 ${keys.length}）、中学 1 年 理科 ${readdirSync(join(data, 'lessons')).filter((f) => /^jhs1-science-\d+-\d+\.md$/.test(f)).length} / 42`,
  `掛け合い ${count((r) => r.talk)} 件（うち歴史・倫理 ${of(history, (r) => r.talk)} / ${of(history, () => true)}）`,
  `動く図解: 入った ${count((r) => r.sim > 0)} 件、調べた ${count((r) => r.sim)} 件`,
]
const media = join(root, 'assets-src', 'media')
if (existsSync(join(media, 'lessons'))) {
  const names = readdirSync(join(media, 'lessons'))
  const checks = names.filter((f) => f.endsWith('.check.json')).map((f) => JSON.parse(readFileSync(join(media, 'lessons', f), 'utf8')))
  lines.push(`挿絵: できた ${names.filter((f) => f.endsWith('.png')).length} 枚（確認で問題なし ${checks.filter((c) => c.ok).length}、問題が残った ${checks.filter((c) => !c.ok).length}、作り直した ${checks.filter((c) => c.attempts > 1).length}）、合う場面なし ${names.filter((f) => f.endsWith('.none')).length} 件`)
}
if (existsSync(join(media, 'people'))) {
  const names = readdirSync(join(media, 'people'))
  const checks = names.filter((f) => f.endsWith('.check.json')).map((f) => JSON.parse(readFileSync(join(media, 'people', f), 'utf8')))
  lines.push(`人物の絵: できた ${names.filter((f) => f.endsWith('.png')).length} 枚（問題なし ${checks.filter((c) => c.ok).length}、問題が残った ${checks.filter((c) => !c.ok).length}）`)
}
console.log(new Date().toLocaleTimeString('ja-JP'), '\n' + lines.join('\n'))
