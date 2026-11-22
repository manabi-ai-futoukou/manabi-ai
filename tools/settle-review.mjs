// 読み直しの指摘を添えて訳し直した授業（translate-lessons.mjs --from-review）について、訳し直す前とあとをくらべて、どちらを残すかを決める。AI は使わない。
//
//   node tools/settle-review.mjs [--lang en]
//
// - 訳し直したあとの訳を読み直した結果（i18n/<言語>/review/）と、訳し直す前の結果（i18n/<言語>/previous/）で、重い問題の数をくらべる。
// - 重い問題が増えていたら、前の訳にもどす（前の読み直しの結果も、もどす）。増えていなければ、新しい訳を残す。
//   どちらの場合も、取っておいた前の訳は消す。
// - 訳し直したあと、まだ読み直していない授業は、そのままにする（先に tools/review-translations.mjs を実行する）。
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : fallback
}
const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const lang = opt('lang', 'en')
const outRoot = join(dataDir, 'i18n', lang)
const previousDir = join(outRoot, 'previous')
const reviewDir = join(outRoot, 'review')
const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12)
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
const heavyOf = (review) => (review?.problems ?? []).filter((p) => p.severity === '重い').length

const count = { kept: 0, restored: 0, pending: 0, before: 0, after: 0 }
if (existsSync(previousDir)) {
  const indexFile = join(outRoot, 'lessons-index.json')
  const index = readJson(indexFile) ?? {}
  for (const file of readdirSync(previousDir).filter((f) => f.endsWith('.md'))) {
    const name = file.slice(0, -3)
    const shipped = name.startsWith('shipped_')
    const id = name.replace(/^shipped_/, '')
    const key = shipped ? `shipped:${id}` : id
    const target = shipped ? join(root, 'resources', 'content', id.replace(/-\d+-\d+$/, ''), `${id}.${lang}.md`) : join(outRoot, 'lessons', `${id}.md`)
    if (!existsSync(target)) continue
    const review = readJson(join(reviewDir, `${name}.json`))
    if (!review || review.stamp !== hash(readFileSync(target, 'utf8'))) {
      count.pending += 1
      continue
    }
    const before = readJson(join(previousDir, `${name}.review.json`))
    const was = before ? heavyOf(before) : Infinity
    const now = heavyOf(review)
    count.before += Number.isFinite(was) ? was : 0
    if (now > was) {
      // 訳し直したほうが悪い。前の訳と、その読み直しの結果にもどす
      copyFileSync(join(previousDir, file), target)
      copyFileSync(join(previousDir, `${name}.review.json`), join(reviewDir, `${name}.json`))
      index[key] = { ...index[key], restored: (index[key]?.restored ?? 0) + 1 }
      count.restored += 1
      count.after += was
      console.log(`${id}: 訳し直したほうが重い問題が多い（${was} → ${now}）ので、前の訳にもどしました`)
    } else {
      count.kept += 1
      count.after += now
    }
    unlinkSync(join(previousDir, file))
    if (existsSync(join(previousDir, `${name}.review.json`))) unlinkSync(join(previousDir, `${name}.review.json`))
  }
  writeFileSync(indexFile, JSON.stringify(index), 'utf8')
}
console.log(`訳し直した訳を残した授業 ${count.kept} 件、前の訳にもどした授業 ${count.restored} 件、まだ読み直していない授業 ${count.pending} 件。重い問題の数: ${count.before} → ${count.after}`)
