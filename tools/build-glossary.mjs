// 授業ごとの注釈（<データ置き場>/annot/<保存名>.json）から、まとめの索引を作る。AI は使わない。
//
//   node --no-warnings tools/build-glossary.mjs
//
// できるもの（どれも <データ置き場>/annot/ の中）:
//   _glossary.json … 用語集の索引（用語・読み・別の書き方・簡単な解説・その用語が出てくる授業）
//   _links.json    … 授業ごとの、前提の授業と、関連する授業
//   _timeline.json … 年表（歴史の科目のできごとを、同じものをまとめて、年の順に並べたもの）
//
// 注釈を作り足したあと（tools/annotate-lessons.mjs のあと）に、もう一度動かす。
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { HISTORY_COURSES } from '../src/shared/annotate.ts'

const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const annotDir = join(dataDir, 'annot')
const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (name, value) => {
  const file = join(annotDir, name)
  writeFileSync(`${file}.tmp`, JSON.stringify(value), 'utf8')
  renameSync(`${file}.tmp`, file)
  return (JSON.stringify(value).length / 1024 / 1024).toFixed(1)
}
const squeeze = (text) => String(text).replace(/[\s　]/g, '').toLowerCase()

// ───────── 授業の並び（学ぶ順） ─────────

const catalog = JSON.parse(readFileSync(join(root, 'resources', 'content', 'catalog.json'), 'utf8'))
const SCHOOLS = ['es', 'jhs', 'hs', 'hsp', 'univ', 'grad']
/** 保存名（学び直し向けをのぞく）→ 学ぶ順・科目・教科・題 */
const lessons = new Map()
catalog.courses.forEach((c, courseIndex) => {
  const shipped = join(root, 'resources', 'content', c.id, 'curriculum.json')
  const curriculum = existsSync(shipped) ? readJson(shipped, null) : readJson(join(dataDir, 'curricula', `${c.id}.json`), null)
  if (!curriculum?.units) return
  // 学年（「1 年」「1・2 年」は数字の大きいほう）。学年で分かれていない科目は、まん中あたりとして扱う
  const grade = Number(c.label.match(/(\d) 年$/)?.[1] ?? (c.school === 'jhs' ? 2 : 1))
  curriculum.units.forEach((unit, u) =>
    unit.lessons.forEach((lesson, l) => {
      const key = `${c.id}-${u + 1}-${l + 1}`
      lessons.set(key, { key, courseId: c.id, school: c.school, subject: c.subject, unit: u, title: lesson.title, rank: SCHOOLS.indexOf(c.school) * 1e8 + grade * 1e6 + courseIndex * 1e4 + u * 100 + l })
    }),
  )
})

// ───────── 注釈を読む ─────────

const annotations = new Map()
for (const name of readdirSync(annotDir)) {
  if (!name.endsWith('.json') || name.startsWith('_')) continue
  const value = readJson(join(annotDir, name), null)
  if (value?.terms) annotations.set(name.slice(0, -5), value)
}
const baseOf = (key) => key.replace(/\.deep$/, '')
console.log(`注釈のある授業: ${annotations.size} 件（単元表にある授業 ${lessons.size} 件）`)

// ───────── 用語集 ─────────

const glossary = new Map()
for (const [key, a] of annotations) {
  const lesson = lessons.get(key)
  if (!lesson) continue // 学び直し向けの本文の用語は、用語集にはのせない（同じ授業の、ふつうの本文の用語をのせる）
  for (const term of a.terms) {
    const id = squeeze(term.term)
    if (!id) continue
    let entry = glossary.get(id)
    if (!entry) glossary.set(id, (entry = { forms: new Map(), readings: new Map(), aliases: new Set(), uses: [] }))
    entry.forms.set(term.term, (entry.forms.get(term.term) ?? 0) + 1)
    entry.readings.set(term.reading, (entry.readings.get(term.reading) ?? 0) + 1)
    for (const alias of term.aliases ?? []) entry.aliases.add(alias)
    entry.uses.push({ key, rank: lesson.rank, short: term.short })
  }
}
const most = (counts) => [...counts].sort((a, b) => b[1] - a[1])[0][0]
const terms = [...glossary.values()].map((entry) => {
  const uses = entry.uses.sort((a, b) => a.rank - b.rank)
  const t = most(entry.forms)
  // 「別の書き方」のうち、それ自体が別の用語として用語集にあるものは、外す（AI が、関係の深い別の用語を入れてしまうことがある）
  const aliases = [...entry.aliases].filter((a) => squeeze(a) !== squeeze(t) && !glossary.has(squeeze(a)))
  return { t, r: most(entry.readings), ...(aliases.length ? { a: aliases.slice(0, 6) } : {}), s: uses[0].short, l: uses.map((u) => u.key) }
})
terms.sort((a, b) => a.r.localeCompare(b.r, 'ja') || a.t.localeCompare(b.t, 'ja'))
console.log(`用語集: ${terms.length} 語（${writeJson('_glossary.json', { at: Date.now(), terms })} MB）`)

// ───────── 前提の授業・関連する授業 ─────────

/** 言葉 → その言葉を用語（または別の書き方・題）として持つ授業 */
const byWord = new Map()
const addWord = (word, key) => {
  const id = squeeze(word)
  if (id.length < 2) return
  if (!byWord.has(id)) byWord.set(id, new Set())
  byWord.get(id).add(key)
}
for (const [key, a] of annotations) {
  if (!lessons.has(key)) continue
  for (const term of a.terms) {
    addWord(term.term, key)
    for (const alias of term.aliases ?? []) addWord(alias, key)
  }
}
for (const lesson of lessons.values()) if (annotations.has(lesson.key) || existsSync(join(dataDir, 'lessons', `${lesson.key}.md`)) || existsSync(join(root, 'resources', 'content', lesson.courseId, `${lesson.key}.md`))) addWord(lesson.title, lesson.key)

/**
 * 教科のまとまり。同じ言葉でも、教科がちがうと意味がちがうことが多い（理科の「抵抗」と、体育の「抵抗」など）ので、
 * 授業どうしを結ぶのは、同じまとまりの教科のあいだだけにする。まとまりに入らない教科（実技・道徳・英語など）は、同じ教科どうしだけ。
 */
const FAMILIES = [
  ['math', 'science', 'risu', 'information', 'techhome'],
  ['social', 'geohistory', 'civics', 'life'],
  ['japanese'],
]
const familyOf = (subject) => FAMILIES.findIndex((family) => family.includes(subject))
const near = (a, b) => a === b || (familyOf(a) >= 0 && familyOf(a) === familyOf(b))

const links = {}
let linked = 0
for (const [key, a] of annotations) {
  const self = lessons.get(baseOf(key))
  if (!self) continue
  const candidates = (word) => [...(byWord.get(squeeze(word)) ?? [])].map((k) => lessons.get(k)).filter((x) => x && x.key !== self.key && near(x.subject, self.subject))
  const used = new Set([self.key])
  const take = (list, entry, via) => {
    if (!entry || used.has(entry.key) || list.length >= 5) return
    used.add(entry.key)
    list.push([entry.key, via])
  }
  /** その言葉が、授業の題に入っているか（その言葉を中心に学ぶ授業） */
  const inTitle = (x, word) => Number(squeeze(x.title).includes(squeeze(word)))
  const pre = []
  // 前提: その言葉を学ぶ授業のうち、この授業より前のもの。同じ教科のものを先に、つぎに、題にその言葉が入っているものを先に、その中では、いちばん近いもの
  for (const word of a.prerequisites ?? []) {
    const before = candidates(word).filter((x) => x.rank < self.rank)
    before.sort((x, y) => Number(y.subject === self.subject) - Number(x.subject === self.subject) || inTitle(y, word) - inTitle(x, word) || y.rank - x.rank)
    take(pre, before[0], word)
  }
  // この授業の用語を、前の学校（学年）でも学んでいれば、それも前提に入れる（2 件まで）
  let earlier = 0
  for (const term of a.terms) {
    if (earlier >= 2) break
    const before = candidates(term.term).filter((x) => x.rank < self.rank && x.courseId !== self.courseId && x.subject === self.subject)
    // 題にその言葉が入っている授業を先に。無ければ、はじめてその言葉を学ぶ授業（いちばん前のもの）
    before.sort((x, y) => inTitle(y, term.term) - inTitle(x, term.term) || x.rank - y.rank)
    if (before[0] && !used.has(before[0].key)) {
      take(pre, before[0], term.term)
      earlier += 1
    }
  }
  const rel = []
  // 関連: その言葉を学ぶ授業のうち、同じ学校のものを先に、その中では、いちばん近いもの
  for (const word of a.related ?? []) {
    const around = candidates(word).filter((x) => x.unit !== self.unit || x.courseId !== self.courseId)
    around.sort((x, y) => Number(y.school === self.school) - Number(x.school === self.school) || inTitle(y, word) - inTitle(x, word) || Math.abs(x.rank - self.rank) - Math.abs(y.rank - self.rank))
    take(rel, around[0], word)
  }
  if (pre.length || rel.length) {
    links[key] = { ...(pre.length ? { pre } : {}), ...(rel.length ? { rel } : {}) }
    linked += 1
  }
}
console.log(`関連する授業: ${linked} 件の授業にリンク（${writeJson('_links.json', links)} MB）`)

// ───────── 年表 ─────────

/** できごとの名前から、「が始まる」「の成立」のような終わりの言葉を外す（同じできごとを見つけるため） */
const core = (label) => squeeze(label).replace(/[・、と]/g, '').replace(/(が|を|に|の)?(始まる|はじまる|起こる|おこる|起きる|成立する|成立|開かれる|ひらかれる|開く|定められる|定める|出される|出す|結ばれる|結ぶ|行われる|行う|終わる|おわる|ほろびる|滅びる|滅亡|建国|即位|発布|制定|公布|開始|勃発|終結|する|される)$/g, '')
const bigrams = (text) => new Set([...text].slice(0, -1).map((_, i) => text.slice(i, i + 2)))
function same(a, b, least = 0.6) {
  const x = core(a)
  const y = core(b)
  if (!x || !y) return false
  if (x === y || (x.length >= 3 && y.includes(x)) || (y.length >= 3 && x.includes(y))) return true
  const p = bigrams(x)
  const q = bigrams(y)
  const shared = [...p].filter((g) => q.has(g)).length
  return shared / Math.max(1, Math.min(p.size, q.size)) >= least
}
/** 同じ年とみなすか。大むかしのできごと（紀元前 1000 年より前）は、授業によって年の言い方がちがうので、4 割までのずれをゆるす */
const nearYear = (a, b) => a === b || (Math.min(a, b) < -1000 && Math.abs(a - b) <= Math.abs(Math.min(a, b)) * 0.4)
const events = []
// 言い方は、やさしいもの（中学 → 小学 → 高校）を先に使う
for (const courseId of ['jhs-history', 'es6-social', 'hs-rekishi-sogo', 'hs-nihonshi', 'hs-sekaishi'].filter((id) => HISTORY_COURSES.includes(id))) {
  for (const [key, a] of annotations) {
    const lesson = lessons.get(key)
    if (!lesson || lesson.courseId !== courseId) continue
    for (const e of a.events ?? []) {
      const found = events.find((x) => x.region === e.region && nearYear(x.year, e.year) && same(x.label, e.label, x.year < -1000 ? 0.5 : 0.6))
      if (found) {
        if (!found.lessons.includes(key)) found.lessons.push(key)
      } else events.push({ year: e.year, yearLabel: e.yearLabel, label: e.label, note: e.note, region: e.region, lessons: [key] })
    }
  }
}
events.sort((a, b) => a.year - b.year)
console.log(`年表: ${events.length} 件（日本 ${events.filter((e) => e.region === 'japan').length}・世界 ${events.filter((e) => e.region === 'world').length}。${writeJson('_timeline.json', { at: Date.now(), events, lessons: {} })} MB）`)
