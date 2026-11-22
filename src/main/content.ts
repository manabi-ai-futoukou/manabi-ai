import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HIDDEN_SCHOOLS, type CharacterDef, type Course, type Curriculum, type Lesson, type LessonMeta, type LessonVariant, type SchoolId, type UnitMeta } from '@shared/types'
import { dataDir, resourcesDir, safeId } from './paths'
import { generatedLessonKeys, getGeneratedCurriculum, getGeneratedLesson, getSettings, lessonKey, saveGeneratedCurriculum } from './store'
import { getLang, t } from '@shared/i18n'
import { normalizeSource } from '@shared/translate'

/**
 * 教材の置き場所は 2 つある。
 *   アプリに同梱（resources/content/<科目>/）… 人が書いて確かめた単元表と授業
 *   利用者のデータ置き場 … AI が作った単元表と授業
 * 同じものが両方にあれば、同梱のものを使う。
 *
 * 表示の言語が日本語でないときは、訳したもの（名前に言語が付いたファイル）を重ねて読む。
 *   科目表   … resources/content/catalog.<言語>.json
 *   登場人物 … resources/content/characters.<言語>.json
 *   単元表   … <データ置き場>/i18n/<言語>/curricula/<科目>.json（同梱の科目は curriculum.<言語>.json）
 *   授業     … <データ置き場>/i18n/<言語>/lessons/<保存名>.md（同梱の授業は <授業の ID>.<言語>.md）
 * 訳が無いものは、日本語のまま見せる。日本語の教材そのものは、どの言語のときも書きかえない。
 */

interface CatalogFile {
  schools: Record<SchoolId, string>
  /** deep: 小学校の科目で、学び直し向け（深掘り）の本文を作らないときに false にする */
  courses: {
    id: string
    school: SchoolId
    subject: string
    subjectLabel: string
    label: string
    lessons: number
    scope: string
    deep?: boolean
    /** 書き方の指示を、教科のものから変えるとき（authoring.ts の SUBJECT_GUIDES の名前） */
    guide?: string
    /** 学校では実習や課題研究として行う科目 */
    practice?: boolean
    /** 訳した科目表にだけある、科目の名前（日本語では、学校・教科・科目の名前から組み立てる） */
    title?: string
  }[]
}

/** 高校の専門教科のうち、職業に関する教科（学習指導要領の区分。理数・体育・音楽・美術・英語は入らない） */
const VOCATIONAL = new Set(['agriculture', 'industry', 'commerce', 'fishery', 'home', 'nursing', 'information', 'welfare'])
/** 高校の専門教科のうち、実技（運動、演奏、制作）が中心の教科 */
const SKILL = new Set(['pe', 'music', 'art'])

/** 単元表のファイル。授業や単元の ID は並び順から決めるので、ここには持たない。 */
export interface CurriculumFile {
  units: { domain?: string; title: string; summary: string; lessons: { title: string; summary: string }[] }[]
}

export const DEFAULT_COURSE_ID = 'jhs1-math'
const SCHOOL_SHORT: Record<SchoolId, string> = { es: t('小学'), jhs: t('中学'), hs: t('高校'), hsp: t('高校（専門）'), univ: t('大学'), grad: t('大学院') }

const readJsonFile = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** 日本語以外で表示しているか */
const translating = () => getLang() !== 'ja'
/** 訳したものの置き場（利用者のデータ置き場の中） */
const i18nDir = (...sub: string[]) => dataDir('i18n', getLang(), ...sub)

/** 訳した科目表（科目の ID → 訳した名前など） */
interface CatalogOverlay {
  schools?: Partial<Record<SchoolId, string>>
  courses?: Record<string, { subjectLabel?: string; label?: string; title?: string; scope?: string }>
}

let catalog: CatalogFile | null = null
function loadCatalog(): CatalogFile {
  if (catalog) return catalog
  const base = JSON.parse(readFileSync(join(resourcesDir('content'), 'catalog.json'), 'utf8')) as CatalogFile
  // いまは公開しない学校（大学・大学院）の科目は、科目表から外す
  base.courses = base.courses.filter((course) => !HIDDEN_SCHOOLS.includes(course.school))
  const overlay = translating() ? readJsonFile<CatalogOverlay>(join(resourcesDir('content'), `catalog.${getLang()}.json`)) : null
  if (overlay) {
    base.schools = { ...base.schools, ...overlay.schools }
    base.courses = base.courses.map((c) => {
      const over = overlay.courses?.[c.id]
      return over ? { ...c, subjectLabel: over.subjectLabel || c.subjectLabel, label: over.label || c.label, scope: over.scope || c.scope, title: over.title || undefined } : c
    })
  }
  return (catalog = base)
}

const curricula = new Map<string, CurriculumFile | null>()
const authored = new Map<string, Set<string>>()

function curriculumFileOf(courseId: string): CurriculumFile | null {
  if (!curricula.has(courseId)) {
    const shipped = join(resourcesDir('content', courseId), 'curriculum.json')
    const file = existsSync(shipped)
      ? (JSON.parse(readFileSync(shipped, 'utf8')) as CurriculumFile)
      : getGeneratedCurriculum<CurriculumFile>(courseId)
    curricula.set(courseId, file?.units?.length ? translatedCurriculum(courseId, file) : null)
  }
  return curricula.get(courseId) ?? null
}

/** 訳した単元表があれば、題と説明を置きかえる（単元と授業の並びが元と同じときだけ） */
function translatedCurriculum(courseId: string, base: CurriculumFile): CurriculumFile {
  if (!translating()) return base
  const shipped = join(resourcesDir('content', courseId), `curriculum.${getLang()}.json`)
  const over = readJsonFile<CurriculumFile>(existsSync(shipped) ? shipped : join(i18nDir('curricula'), `${courseId}.json`))
  if (!over?.units || over.units.length !== base.units.length) return base
  return {
    units: base.units.map((unit, u) => {
      const o = over.units[u]
      return {
        domain: o.domain || unit.domain,
        title: o.title || unit.title,
        summary: o.summary || unit.summary,
        lessons: unit.lessons.map((lesson, l) => ({ title: o.lessons?.[l]?.title || lesson.title, summary: o.lessons?.[l]?.summary || lesson.summary })),
      }
    }),
  }
}

/** AI が作った単元表を保存する */
export function saveCurriculum(courseId: string, file: CurriculumFile): void {
  saveGeneratedCurriculum(courseId, file)
  curricula.delete(courseId)
}

/** 同梱されている（人が書いた）授業の ID */
function authoredLessons(courseId: string): Set<string> {
  let ids = authored.get(courseId)
  if (!ids) {
    const dir = resourcesDir('content', courseId)
    ids = new Set(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)) : [])
    authored.set(courseId, ids)
  }
  return ids
}

const lessonIdOf = (courseId: string, unit: number, lesson: number) => `${courseId}-${unit + 1}-${lesson + 1}`

function courseTitle(c: CatalogFile['courses'][number]): string {
  if (c.title) return c.title
  // 「1 年」「1・2 年」のように学年で分かれている科目
  if (/^\d(・\d)? 年$/.test(c.label)) return `${SCHOOL_SHORT[c.school]} ${c.label} ${c.subjectLabel}`
  if (c.school === 'hs') return t('高校 {0}', c.label)
  // 専門教科は、ちがう教科に同じ名前の科目がある（課題研究など）ので、教科の名前を付ける
  if (c.school === 'hsp') return t('高校 {0}（{1}）', c.subjectLabel, c.label)
  // 大学・大学院は、ちがう学科に同じ名前の科目がある（統計学など）ので、学科の名前を付ける
  if (c.school === 'univ') return t('大学 {0}（{1}）', c.label, c.subjectLabel)
  if (c.school === 'grad') return t('大学院 {0}（{1}）', c.label, c.subjectLabel)
  return c.label === c.subjectLabel ? `${SCHOOL_SHORT[c.school]} ${c.label}` : `${SCHOOL_SHORT[c.school]} ${c.subjectLabel}（${c.label}）`
}

function toCourse(c: CatalogFile['courses'][number]): Course {
  const file = curriculumFileOf(c.id)
  const generated = generatedLessonKeys()
  const written = authoredLessons(c.id)
  let total = 0
  let ready = 0
  file?.units.forEach((unit, u) =>
    unit.lessons.forEach((_lesson, l) => {
      const id = lessonIdOf(c.id, u, l)
      total += 1
      if (written.has(id) || generated.has(id)) ready += 1
    }),
  )
  return {
    id: c.id,
    school: c.school,
    schoolLabel: loadCatalog().schools[c.school],
    subject: c.subject,
    subjectLabel: c.subjectLabel,
    label: c.label,
    title: courseTitle(c),
    subjectId: `${c.school}-${c.subject}`,
    scope: c.scope,
    lessonTarget: c.lessons,
    hasDeep: c.school === 'es' && c.deep !== false,
    guide: c.guide ?? c.subject,
    vocational: c.school === 'hsp' && VOCATIONAL.has(c.subject),
    higher: c.school === 'univ' || c.school === 'grad',
    skill: c.school === 'hsp' && SKILL.has(c.subject),
    practice: !!c.practice,
    hasCurriculum: !!file,
    ready,
    total: file ? total : c.lessons,
  }
}

export function listCourses(): Course[] {
  return loadCatalog().courses.map(toCourse)
}

export function getCourse(courseId: string): Course | null {
  const found = loadCatalog().courses.find((c) => c.id === courseId)
  return found ? toCourse(found) : null
}

/** 授業の ID（<科目>-<単元>-<授業>）から、科目の ID を取り出す */
export const courseIdOfLesson = (lessonId: string) => lessonId.replace(/-\d+-\d+$/, '')

export function getCurriculum(courseId: string): Curriculum | null {
  const course = getCourse(courseId)
  const file = curriculumFileOf(courseId)
  if (!course || !file) return null
  const generated = generatedLessonKeys()
  const written = authoredLessons(courseId)
  const units: UnitMeta[] = file.units.map((unit, u) => ({
    id: `${courseId}-u${u + 1}`,
    number: u + 1,
    domain: unit.domain ?? '',
    title: unit.title,
    summary: unit.summary,
    lessons: unit.lessons.map((lesson, l) => {
      const id = lessonIdOf(courseId, u, l)
      return {
        id,
        unitId: `${courseId}-u${u + 1}`,
        number: `${u + 1}-${l + 1}`,
        title: lesson.title,
        summary: lesson.summary,
        status: written.has(id) ? 'authored' : generated.has(id) ? 'generated' : 'none',
        ...(course.hasDeep ? { deep: generated.has(lessonKey(id, 'deep')) } : {}),
      } satisfies LessonMeta
    }),
  }))
  return { id: courseId, title: course.title, course, units }
}

export function findLessonMeta(lessonId: string): { course: Course; unit: UnitMeta; lesson: LessonMeta } | null {
  const curriculum = getCurriculum(courseIdOfLesson(lessonId))
  if (!curriculum) return null
  for (const unit of curriculum.units) {
    const lesson = unit.lessons.find((l) => l.id === lessonId)
    if (lesson) return { course: curriculum.course, unit, lesson }
  }
  return null
}

/** 評価をまとめる単位（学校 + 教科）。単元表に無い授業（自由ノートなど）は null。 */
export function subjectOfLesson(lessonId: string | null): string | null {
  if (!lessonId) return null
  return getCourse(courseIdOfLesson(lessonId))?.subjectId ?? null
}

/** 「中学 数学」のような、教科の名前 */
export function subjectTitle(subjectId: string): string {
  const course = loadCatalog().courses.find((c) => `${c.school}-${c.subject}` === subjectId)
  return course ? `${SCHOOL_SHORT[course.school]} ${course.subjectLabel}` : subjectId
}

/**
 * 本文つきの授業。まだ用意されていない（AI 生成もされていない）場合は null。
 * 学び直し向け（deep）は小学校の科目にだけあり、ほかの科目ではふつうの本文を返す。
 */
export function getLesson(lessonId: string, variant: LessonVariant = 'standard'): Lesson | null {
  const found = findLessonMeta(safeId(lessonId))
  if (!found) return null
  const { course, unit, lesson } = found
  const wanted: LessonVariant = variant === 'deep' && course.hasDeep ? 'deep' : 'standard'
  const base = { ...lesson, courseId: course.id, courseTitle: course.title, unitTitle: unit.title, variant: wanted }
  if (wanted === 'standard' && lesson.status === 'authored') {
    const dir = resourcesDir('content', course.id)
    const source = readFileSync(join(dir, `${lessonId}.md`), 'utf8')
    const translated = translating() ? readText(join(dir, `${lessonId}.${getLang()}.md`)) : null
    return { ...base, reviewed: true, body: translated ?? source, ...(translating() && translated === null ? { untranslated: true } : {}), ...(translated !== null && sourceChanged(`shipped:${lessonId}`, [source]) ? { outdated: true } : {}) }
  }
  const generated = getGeneratedLesson(lessonId, wanted)
  if (!generated) return null
  if (!translating()) return { ...base, ...generated }
  const key = lessonKey(lessonId, wanted)
  const translated = readText(join(i18nDir('lessons'), `${key}.md`))
  if (translated === null) return { ...base, ...generated, untranslated: true }
  // 訳の記録の指紋は、道具が訳したときはファイルのままの本文、アプリの中で訳したときは見出しの番号を外した本文から作られている
  const outdated = sourceChanged(key, [readText(join(dataDir('lessons'), `${key}.md`)) ?? generated.body, generated.body])
  return { ...base, ...generated, body: translated, ...(outdated ? { outdated: true } : {}) }
}

/** 訳した記録（保存名 → 訳したときの、日本語の本文の指紋）。まとめて訳す道具と、アプリの中の訳の両方が書く */
let translationRecords: { stamp: number; lang: string; records: Record<string, { src?: string }> } | null = null

/**
 * 訳したあとに、日本語の本文が書き直されたか（授業を掘り下げて書き直したとき、訳は前の版のまま残る）。
 * candidates のどれかの指紋が、訳したときのものと同じなら「変わっていない」。記録が無いときは、分からないので false。
 */
function sourceChanged(key: string, candidates: string[]): boolean {
  const file = join(i18nDir(), 'lessons-index.json')
  const stamp = existsSync(file) ? statSync(file).mtimeMs : 0
  if (!translationRecords || translationRecords.stamp !== stamp || translationRecords.lang !== getLang()) {
    translationRecords = { stamp, lang: getLang(), records: (stamp && readJsonFile<Record<string, { src?: string }>>(file)) || {} }
  }
  const from = translationRecords.records[key]?.src
  if (!from) return false
  return !candidates.some((body) => createHash('sha1').update(normalizeSource(body)).digest('hex').slice(0, 12) === from)
}

/** 日本語の本文（訳すときの元。表示の言語に関係なく、いつも日本語のものを返す） */
export function getSourceLesson(lessonId: string, variant: LessonVariant = 'standard'): { key: string; body: string; authored: boolean; courseId: string } | null {
  const found = findLessonMeta(safeId(lessonId))
  if (!found) return null
  const wanted: LessonVariant = variant === 'deep' && found.course.hasDeep ? 'deep' : 'standard'
  if (wanted === 'standard' && found.lesson.status === 'authored') {
    return { key: lessonId, body: readFileSync(join(resourcesDir('content', found.course.id), `${lessonId}.md`), 'utf8'), authored: true, courseId: found.course.id }
  }
  const generated = getGeneratedLesson(lessonId, wanted)
  return generated ? { key: lessonKey(lessonId, wanted), body: generated.body, authored: false, courseId: found.course.id } : null
}

/** 訳した授業の置き場所（同梱の授業は、同じフォルダに言語の名前を付けて置く） */
export function translatedLessonFile(source: { key: string; authored: boolean; courseId: string }): string {
  return source.authored ? join(resourcesDir('content', source.courseId), `${source.key}.${getLang()}.md`) : join(i18nDir('lessons'), `${source.key}.md`)
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 訳すときに要る、科目の情報（名前は、いつも日本語のもの） */
export function sourceCourse(courseId: string): { id: string; school: string; subject: string; subjectLabel: string; label: string } | null {
  const all = JSON.parse(readFileSync(join(resourcesDir('content'), 'catalog.json'), 'utf8')) as CatalogFile
  const found = all.courses.find((c) => c.id === courseId)
  return found ? { id: found.id, school: found.school, subject: found.subject, subjectLabel: found.subjectLabel, label: found.label } : null
}

/**
 * 掛け合いに出てくる歴史上の人物の、名前の訳（日本語の名前 → 訳）。
 * 本文の話し手は、絵を引くために日本語の名前のままにしてあるので、画面に出すときにこの表で置きかえる。
 */
let people: { stamp: number; names: Record<string, string> } | null = null
export function personNames(): Record<string, string> {
  if (!translating()) return {}
  const file = join(i18nDir(), 'people.json')
  const stamp = existsSync(file) ? statSync(file).mtimeMs : 0
  if (!people || people.stamp !== stamp) people = { stamp, names: (stamp && readJsonFile<Record<string, string>>(file)) || {} }
  return people.names
}

export function getCharacters(): CharacterDef[] {
  const defaults = JSON.parse(readFileSync(join(resourcesDir('content'), 'characters.json'), 'utf8')) as CharacterDef[]
  if (!translating()) {
    const overrides = getSettings().characterOverrides
    return defaults.map((c) => ({ ...c, ...overrides[c.id] }))
  }
  // 名前・人物像・話し方は訳したものを使う。利用者の書きかえも、言語ごとに別に持つ
  const translated = readJsonFile<Partial<CharacterDef>[]>(join(resourcesDir('content'), `characters.${getLang()}.json`)) ?? []
  const overrides = getSettings().characterOverridesByLang?.[getLang()] ?? {}
  return defaults.map((c) => {
    const over = translated.find((x) => x.id === c.id)
    return { ...c, ...over, expressions: c.expressions, expressionHints: { ...c.expressionHints, ...over?.expressionHints }, ...overrides[c.id] }
  })
}

export function getCharacter(id: string): CharacterDef {
  const all = getCharacters()
  return all.find((c) => c.id === id) ?? all[0]
}
