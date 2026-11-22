import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { HISTORY_COURSES, annotationSchema, annotationSystemPrompt, annotationUserPrompt, cleanAnnotation, kanjiIn, type LessonAnnotation } from '@shared/annotate'
import { findSnippets, searchPattern } from '@shared/search'
import type { GlossaryEntry, GlossaryList, GlossaryQuery, LessonLinks, LessonVariant, SearchHit, SearchQuery, SearchResult, TimelineData } from '@shared/types'
import { getLang, t } from '@shared/i18n'
import { askStructured } from './ai/ask'
import { courseIdOfLesson, findLessonMeta, getSourceLesson, listCourses } from './content'
import { dataDir, resourcesDir, safeId } from './paths'
import { getNotebook, getSettings, lessonKey, listNotebooks } from './store'

/**
 * 授業ごとの「注釈」（用語集・ふりがな・前提と関連・年表のできごと）と、それをまとめた索引。
 *
 *   <データ置き場>/annot/<保存名>.json … 1 つの授業の注釈（道具 tools/annotate-lessons.mjs か、アプリの中で作る）
 *   <データ置き場>/annot/_glossary.json … 用語集の索引（道具 tools/build-glossary.mjs が作る）
 *   <データ置き場>/annot/_links.json    … 授業ごとの、前提の授業・関連する授業
 *   <データ置き場>/annot/_timeline.json … 年表
 *
 * 注釈は、日本語の授業から作る。表示の言語が日本語でないときは、使わない。
 */

const annotDir = () => dataDir('annot')
const readJsonFile = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}
const hashOf = (text: string) => createHash('sha1').update(text.replaceAll('\r\n', '\n')).digest('hex').slice(0, 12)
const variantOf = (key: string): LessonVariant => (key.endsWith('.deep') ? 'deep' : 'standard')
const idOf = (key: string) => key.replace(/\.deep$/, '')

/** その授業の注釈。まだ作られていなければ null（日本語以外で表示しているときも null） */
export function getAnnotation(lessonId: string, variant: LessonVariant = 'standard'): LessonAnnotation | null {
  if (getLang() !== 'ja') return null
  const source = getSourceLesson(safeId(lessonId), variant)
  if (!source) return null
  return readJsonFile<LessonAnnotation>(join(annotDir(), `${source.key}.json`))
}

let grades: Record<string, number> | null = null
function kanjiGrade(char: string): number {
  grades ??= Object.fromEntries(
    Object.entries((JSON.parse(gunzipSync(readFileSync(join(resourcesDir('kanji'), 'kanji.json.gz'))).toString('utf8')) as { kanji: Record<string, { g: number }> }).kanji).map(([ch, raw]) => [ch, raw.g || 99]),
  )
  return grades[char] ?? 99
}

/** その授業の注釈を、いま AI に作ってもらう（まとめて作る道具と同じ指示文・確かめを使う） */
export async function makeAnnotation(lessonId: string, variant: LessonVariant = 'standard'): Promise<LessonAnnotation> {
  if (getLang() !== 'ja') throw new Error(t('用語とふりがなは、日本語で表示しているときに作ります。'))
  const found = findLessonMeta(safeId(lessonId))
  const source = getSourceLesson(lessonId, variant)
  if (!found || !source) throw new Error(t('授業が見つかりません。'))
  const deep = source.key.endsWith('.deep')
  const grade = found.course.school === 'es' ? Number(/(\d) 年$/.exec(found.course.label)?.[1] ?? 6) : null
  const history = HISTORY_COURSES.includes(found.course.id)
  const limit = found.course.school === 'es' && !deep ? (grade ?? 6) : 8
  const target = {
    school: found.course.school,
    courseTitle: found.course.title,
    grade,
    deep,
    unitTitle: found.unit.title,
    number: found.lesson.number,
    title: found.lesson.title,
    history,
    body: source.body,
    hardKanji: kanjiIn(source.body).filter((ch) => kanjiGrade(ch) > limit),
  }
  const raw = await askStructured<unknown>(getSettings().ai, annotationSystemPrompt(target), annotationUserPrompt(target), annotationSchema(history))
  const annotation: LessonAnnotation = { src: hashOf(source.body), at: Date.now(), ...cleanAnnotation(raw, source.body, history).annotation }
  writeFileSync(join(annotDir(), `${source.key}.json`), JSON.stringify(annotation), 'utf8')
  return annotation
}

// ───────── 索引（用語集・関連する授業・年表） ─────────

interface GlossaryIndex {
  at: number
  /** t: 用語 / r: 読み / a: 別の書き方 / s: 簡単な解説（いちばん早く学ぶ授業のもの） / l: その用語が出てくる授業（保存名。学ぶ順） */
  terms: { t: string; r: string; a?: string[]; s: string; l: string[] }[]
}

/** 索引のファイルを、変わったときだけ読み直す */
function cached<T>(name: string): () => T | null {
  let stamp = -1
  let value: T | null = null
  return () => {
    const file = join(annotDir(), name)
    const now = existsSync(file) ? statSync(file).mtimeMs : 0
    if (now !== stamp) {
      stamp = now
      value = now ? readJsonFile<T>(file) : null
    }
    return value
  }
}
const glossaryIndex = cached<GlossaryIndex>('_glossary.json')
const linksIndex = cached<Record<string, { pre?: [string, string][]; rel?: [string, string][] }>>('_links.json')
const timelineIndex = cached<TimelineData>('_timeline.json')

/** 保存名から、画面に出す授業の情報を作る */
function lessonInfo(key: string): { lessonId: string; variant: LessonVariant; courseId: string; courseTitle: string; school: string; subject: string; number: string; title: string } | null {
  const found = findLessonMeta(idOf(key))
  if (!found) return null
  return { lessonId: idOf(key), variant: variantOf(key), courseId: found.course.id, courseTitle: found.course.title, school: found.course.school, subject: found.course.subject, number: found.lesson.number, title: found.lesson.title }
}

const KANA_ROWS: [string, RegExp][] = [
  ['あ', /^[あ-おぁ-ぉゔ]/],
  ['か', /^[か-ご]/],
  ['さ', /^[さ-ぞ]/],
  ['た', /^[た-どっ]/],
  ['な', /^[な-の]/],
  ['は', /^[は-ぽ]/],
  ['ま', /^[ま-も]/],
  ['や', /^[や-よゃ-ょ]/],
  ['ら', /^[ら-ろ]/],
  ['わ', /^[わ-んゎ]/],
]
const schoolOfKey = (key: string) => (key.startsWith('es') ? 'es' : key.startsWith('jhs') ? 'jhs' : key.startsWith('hsp') ? 'hsp' : key.startsWith('hs') ? 'hs' : key.startsWith('univ') ? 'univ' : 'grad')
const squeeze = (text: string) => text.replace(/[\s　]/g, '').toLowerCase()

/** 用語集の一覧（しぼりこみ・検索つき） */
export function listGlossary(query: GlossaryQuery): GlossaryList {
  const index = getLang() === 'ja' ? glossaryIndex() : null
  if (!index) return { ready: false, total: 0, items: [], updatedAt: 0 }
  const word = squeeze(String(query.query ?? ''))
  const row = KANA_ROWS.find(([name]) => name === query.initial)?.[1]
  const courses = query.subject ? new Set(listCourses().filter((c) => c.subject === query.subject).map((c) => c.id)) : null
  const matched = index.terms.filter((entry) => {
    if (row && !row.test(entry.r)) return false
    if (query.school && !entry.l.some((key) => schoolOfKey(key) === query.school)) return false
    if (courses && !entry.l.some((key) => courses.has(courseIdOfLesson(idOf(key))))) return false
    if (!word) return true
    return squeeze(entry.t).includes(word) || entry.r.includes(word) || (entry.a ?? []).some((a) => squeeze(a).includes(word)) || (query.inText ? squeeze(entry.s).includes(word) : false)
  })
  // 言葉で探したときは、用語がその言葉で始まるものを先に出す
  if (word) matched.sort((a, b) => Number(squeeze(b.t).startsWith(word) || b.r.startsWith(word)) - Number(squeeze(a.t).startsWith(word) || a.r.startsWith(word)) || a.t.length - b.t.length)
  const offset = Math.max(0, Number(query.offset) || 0)
  const limit = Math.max(1, Math.min(300, Number(query.limit) || 100))
  return {
    ready: true,
    total: matched.length,
    updatedAt: index.at,
    items: matched.slice(offset, offset + limit).map((entry) => ({ term: entry.t, reading: entry.r, short: entry.s, count: entry.l.length, schools: [...new Set(entry.l.map(schoolOfKey))] })),
  }
}

/** 用語 1 つの、くわしい中身（どの授業で、どう説明されているか） */
export function getGlossaryTerm(term: string): GlossaryEntry | null {
  const index = getLang() === 'ja' ? glossaryIndex() : null
  const wanted = squeeze(String(term ?? ''))
  if (!index || !wanted) return null
  const entry = index.terms.find((e) => squeeze(e.t) === wanted) ?? index.terms.find((e) => (e.a ?? []).some((a) => squeeze(a) === wanted))
  if (!entry) return null
  const uses = []
  // 多くの授業に出てくる用語は、学ぶ順に 12 件まで
  for (const key of entry.l.slice(0, 12)) {
    const info = lessonInfo(key)
    const found = readJsonFile<LessonAnnotation>(join(annotDir(), `${key}.json`))?.terms.find((x) => squeeze(x.term) === squeeze(entry.t))
    if (info && found) uses.push({ ...info, short: found.short, detail: found.detail })
  }
  return { term: entry.t, reading: entry.r, aliases: entry.a ?? [], total: entry.l.length, uses }
}

/** その授業の、前提の授業と、関連する授業 */
export function getLessonLinks(lessonId: string, variant: LessonVariant = 'standard'): LessonLinks {
  const index = getLang() === 'ja' ? linksIndex() : null
  const found = index?.[lessonKey(lessonId, variant)] ?? index?.[safeId(lessonId)]
  const expand = (list: [string, string][] | undefined) =>
    (list ?? []).flatMap(([key, via]) => {
      const info = lessonInfo(key)
      return info ? [{ ...info, via }] : []
    })
  return { prerequisites: expand(found?.pre), related: expand(found?.rel) }
}

export function getTimeline(): TimelineData | null {
  const data = getLang() === 'ja' ? timelineIndex() : null
  if (!data) return null
  // 授業の名前は、開いたときの単元表から引く（索引には、保存名だけがある）
  const names: TimelineData['lessons'] = {}
  for (const event of data.events) {
    for (const key of event.lessons) {
      if (names[key]) continue
      const info = lessonInfo(key)
      if (info) names[key] = { lessonId: info.lessonId, variant: info.variant, courseTitle: info.courseTitle, number: info.number, title: info.title }
    }
  }
  return { ...data, lessons: names }
}

// ───────── 検索（教科書・ノート・メモ・用語集） ─────────

/** 教科書を探した結果（授業の名前を引く前のもの） */
export interface RawLessonHit {
  key: string
  count: number
  snippets: string[]
}

/** 探した結果に、授業の名前を付けて、並べる（題に言葉が入っている授業を先に、あとは出てくる回数の多い順） */
export function lessonHits(raw: RawLessonHit[], query: SearchQuery, limit: number): SearchHit[] {
  const pattern = searchPattern(query.query)
  if (!pattern) return []
  const found: SearchHit[] = []
  for (const item of raw) {
    const info = lessonInfo(item.key)
    if (info) found.push({ source: 'textbook', title: `${info.number} ${info.title}`, where: `${info.courseTitle}${info.variant === 'deep' ? t('（学び直し）') : ''}`, snippets: item.snippets, count: item.count, lessonId: info.lessonId, variant: info.variant, inTitle: pattern.test(info.title) })
  }
  // 題に言葉が入っている授業を先に。つぎに、小・中・高の授業を、高校（専門）・大学より先に。あとは、出てくる回数の多い順
  const core = (hit: SearchHit) => Number(/^(es|jhs|hs)(?!p)/.test(hit.lessonId ?? ''))
  found.sort((a, b) => Number(b.inTitle) - Number(a.inTitle) || core(b) - core(a) || b.count - a.count)
  return found.slice(0, limit)
}

/** 教科書（授業の本文）を探す。ファイルを 1 つずつ読むので、少しずつ（ほかの操作を止めないように） */
export async function searchLessons(query: SearchQuery, limit: number): Promise<{ hits: SearchHit[]; total: number }> {
  const pattern = searchPattern(query.query)
  if (!pattern) return { hits: [], total: 0 }
  const schools = query.schools?.length ? new Set(query.schools) : null
  const files: { key: string; file: string }[] = []
  const dir = dataDir('lessons')
  const generated = new Set(readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)))
  for (const course of listCourses()) {
    if (query.courseId ? course.id !== query.courseId : schools && !schools.has(course.school)) continue
    const shipped = resourcesDir('content', course.id)
    const authored = existsSync(shipped) ? readdirSync(shipped).filter((f) => /-\d+-\d+\.md$/.test(f)).map((f) => f.slice(0, -3)) : []
    for (const id of authored) files.push({ key: id, file: join(shipped, `${id}.md`) })
    for (const key of generated) if (courseIdOfLesson(idOf(key)) === course.id && !authored.includes(key)) files.push({ key, file: join(dir, `${key}.md`) })
  }
  const raw: RawLessonHit[] = []
  const BATCH = 48
  for (let at = 0; at < files.length; at += BATCH) {
    const bodies = await Promise.all(files.slice(at, at + BATCH).map(({ file }) => readFile(file, 'utf8').catch(() => '')))
    bodies.forEach((body, i) => {
      const { count, snippets } = findSnippets(body, pattern, 2)
      if (count) raw.push({ key: files[at + i].key, count, snippets })
    })
  }
  return { hits: lessonHits(raw, query, limit), total: raw.length }
}

/**
 * 検索。選んだ範囲（教科書・ノート・メモ・用語集）から探す。
 * @param lessons 教科書の探し方（Web 版では、サーバーに探してもらうものに差しかえる）
 */
export async function runSearch(query: SearchQuery, lessons: (query: SearchQuery) => Promise<{ hits: SearchHit[]; total: number }> = (q) => searchLessons(q, 60)): Promise<SearchResult> {
  const clean: SearchQuery = { query: String(query?.query ?? '').slice(0, 60), sources: Array.isArray(query?.sources) ? query.sources : [], schools: Array.isArray(query?.schools) ? query.schools.map(String) : [], courseId: query?.courseId ? safeId(query.courseId) : undefined }
  const result: SearchResult = { hits: [], totals: {} }
  if (!searchPattern(clean.query)) return result
  if (clean.sources.includes('glossary')) {
    const found = searchGlossary(clean, 30)
    result.hits.push(...found.hits)
    result.totals.glossary = found.total
  }
  for (const kind of ['memo', 'note'] as const) {
    if (!clean.sources.includes(kind)) continue
    const found = searchNotebooks(clean, [kind === 'memo' ? 'memo' : 'lesson'], 40)
    result.hits.push(...found)
    result.totals[kind] = found.length
  }
  if (clean.sources.includes('textbook')) {
    const found = await lessons(clean)
    result.hits.push(...found.hits)
    result.totals.textbook = found.total
  }
  return result
}

/** ノートとメモを探す（題、タイピングした文字、入力した文字、手書きの文字起こし） */
export function searchNotebooks(query: SearchQuery, kinds: ('lesson' | 'memo')[], limit: number): SearchHit[] {
  const pattern = searchPattern(query.query)
  if (!pattern) return []
  const hits: SearchHit[] = []
  for (const summary of listNotebooks()) {
    if (!kinds.includes(summary.kind as 'lesson' | 'memo')) continue
    const notebook = getNotebook(summary.id)
    if (!notebook) continue
    const inTitle = pattern.test(notebook.title)
    notebook.pages.forEach((page, index) => {
      const text = [page.typed ?? '', ...page.texts.map((box) => box.text), ...(page.objects ?? []).flatMap((o) => (o.type === 'table' ? o.cells.flat() : o.type === 'link' ? [o.title] : [])), page.transcript ?? ''].join('\n')
      const { count, snippets } = findSnippets(text, pattern, 2)
      if (!count) return
      hits.push({ source: summary.kind === 'memo' ? 'memo' : 'note', title: notebook.title, where: `p.${index + 1}`, snippets, count, notebookId: notebook.id, page: index + 1, inTitle })
    })
    // 題だけに言葉があるノートも出す
    if (inTitle && !hits.some((hit) => hit.notebookId === notebook.id)) hits.push({ source: summary.kind === 'memo' ? 'memo' : 'note', title: notebook.title, where: '', snippets: [], count: 0, notebookId: notebook.id, page: 1, inTitle })
  }
  hits.sort((a, b) => Number(b.inTitle) - Number(a.inTitle) || b.count - a.count)
  return hits.slice(0, limit)
}

/** 用語集を探す（用語・読み・簡単な解説） */
export function searchGlossary(query: SearchQuery, limit: number): { hits: SearchHit[]; total: number } {
  const list = listGlossary({ query: query.query, inText: true, limit })
  return { total: list.total, hits: list.items.map((item) => ({ source: 'glossary' as const, title: item.term, where: item.reading, snippets: [item.short], count: item.count, term: item.term, inTitle: true })) }
}
