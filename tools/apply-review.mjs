// 読み直し（tools/review-translations.mjs）で見つかった問題の直しを、訳した授業に入れる。AI は使わない。
//
//   node tools/apply-review.mjs [--lang en] [--severity 重い|all] [--only 授業の保存名,…] [--skip 授業の保存名#番号,…] [--dry]
//
// - 入れるのは、直し（fix）が書いてあって、直す場所（where）が訳の中にちょうど 1 か所だけ見つかるもの。
// - 入れたあとで、形（見出し・ブロック・表・掛け合い・図）が元の授業と同じかを確かめ、くずれる直しは入れない。
// - 読み直したあとで訳が変わっている授業は飛ばす（もう一度読み直してから）。
// - --skip には、入れたくない直しを「保存名#番号」（番号は、その授業の問題の 1 からの順番）で書く。--dry は、何を入れるかを出すだけ。
// - 入れた記録は <データ置き場>/i18n/<言語>/review-applied.json。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Mismatch, lessonKind, normalizeSource, settleTranslation } from '../src/shared/translate.ts'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : fallback
}
const has = (name) => args.includes(`--${name}`)
const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const lang = opt('lang', 'en')
const severity = opt('severity', '重い')
const only = opt('only', '').split(',').filter(Boolean)
const skip = new Set(opt('skip', '').split(',').filter(Boolean))
const outRoot = join(dataDir, 'i18n', lang)
const reviewDir = join(outRoot, 'review')
const catalog = JSON.parse(readFileSync(join(root, 'resources', 'content', 'catalog.json'), 'utf8'))
const courses = new Map(catalog.courses.map((c) => [c.id, c]))
const courseOf = (key) => courses.get(key.replace(/\.deep$/, '').replace(/-\d+-\d+$/, ''))
const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12)
const index = JSON.parse(readFileSync(join(outRoot, 'lessons-index.json'), 'utf8'))
const appliedFile = join(outRoot, 'review-applied.json')
const applied = existsSync(appliedFile) ? JSON.parse(readFileSync(appliedFile, 'utf8')) : {}

const japanese = (text) => (text.match(/[぀-ヿ㐀-鿿]/g) ?? []).length
const count = { lessons: 0, fixes: 0, notFound: 0, noFix: 0, unsafe: 0, broke: 0, stale: 0, skipped: 0 }
for (const file of readdirSync(reviewDir).filter((f) => f.endsWith('.json'))) {
  const name = file.slice(0, -5)
  const shipped = name.startsWith('shipped_')
  const id = name.replace(/^shipped_/, '')
  if (only.length && !only.includes(id)) continue
  const review = JSON.parse(readFileSync(join(reviewDir, file), 'utf8'))
  const wanted = review.problems.map((p, i) => ({ ...p, n: i + 1 })).filter((p) => severity === 'all' || p.severity === severity)
  if (!wanted.length) continue
  const course = courseOf(id)
  const target = shipped ? join(root, 'resources', 'content', course.id, `${id}.${lang}.md`) : join(outRoot, 'lessons', `${id}.md`)
  const source = shipped ? join(root, 'resources', 'content', course.id, `${id}.md`) : join(dataDir, 'lessons', `${id}.md`)
  if (!existsSync(target) || !existsSync(source)) continue
  let text = readFileSync(target, 'utf8')
  if (hash(text) !== review.stamp) {
    count.stale += 1
    continue
  }
  const body = normalizeSource(readFileSync(source, 'utf8'))
  const kind = lessonKind(course)
  const lenient = !!index[shipped ? `shipped:${id}` : id]?.lenient
  const done = []
  for (const p of wanted) {
    if (skip.has(`${id}#${p.n}`)) {
      count.skipped += 1
      continue
    }
    if (!p.fix || !p.fix.trim() || p.fix === p.where) {
      count.noFix += 1
      continue
    }
    // 直しの文に、元の場所には無かった日本語が入っているもの（AI が、直した文の代わりに「こう直す」という説明を書いたもの）は入れない
    if (kind !== 'japanese' && japanese(p.fix) > japanese(p.where)) {
      count.unsafe += 1
      continue
    }
    const at = text.indexOf(p.where)
    if (at < 0 || text.indexOf(p.where, at + 1) >= 0) {
      count.notFound += 1
      continue
    }
    const next = text.slice(0, at) + p.fix + text.slice(at + p.where.length)
    try {
      // 形が元の授業と同じままかを確かめる（ととのえた結果は使わない。直しを入れた文そのものを残す）
      settleTranslation(body, next, kind, {}, lenient)
    } catch (error) {
      if (!(error instanceof Mismatch)) throw error
      count.broke += 1
      continue
    }
    text = next
    done.push({ n: p.n, severity: p.severity, what: p.what, where: p.where, fix: p.fix })
  }
  if (!done.length) continue
  count.lessons += 1
  count.fixes += done.length
  if (has('dry')) {
    for (const d of done) console.log(`${id}#${d.n} [${d.severity}] ${d.what}\n   − ${d.where.slice(0, 200)}\n   ＋ ${d.fix.slice(0, 200)}`)
    continue
  }
  writeFileSync(target, text, 'utf8')
  applied[shipped ? `shipped:${id}` : id] = [...(applied[shipped ? `shipped:${id}` : id] ?? []), ...done.map((d) => ({ ...d, at: Date.now() }))]
}
if (!has('dry')) writeFileSync(appliedFile, JSON.stringify(applied, null, 1), 'utf8')
console.log(`${has('dry') ? '（試し）' : ''}直しを入れた授業 ${count.lessons} 件・直し ${count.fixes} 個。入れなかったもの: 直しが書かれていない ${count.noFix}、場所が見つからない ${count.notFound}、直しに日本語の説明が入っている ${count.unsafe}、形がくずれる ${count.broke}、--skip ${count.skipped}、読み直しのあとで訳が変わった授業 ${count.stale} 件`)
