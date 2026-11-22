import { powerSaveBlocker } from 'electron'
import { hasBlock, insertAfterSection, stripBlocks } from '@shared/blocks'
import { compileGraph, formatSim, normalizeSim, simsFor } from '@shared/sims'
import { hasTalk, insertTalk, stripTalk, type LessonTalk, type TalkLine } from '@shared/talk'
import type { CharacterDef, Course, Lesson, LessonVariant, LibraryOptions, LibraryState } from '@shared/types'
import { askStructured, askText } from './ai/ask'
import {
  CURRICULUM_SCHEMA,
  curriculumSystemPrompt,
  NO_GUEST,
  REVIEW_SCHEMA,
  SIM_SCHEMA,
  TALK_SCHEMA,
  allowsGuest,
  allowsTalk,
  callName,
  curriculumUserPrompt,
  lessonSystemPrompt,
  lessonUserPrompt,
  reviewSystemPrompt,
  reviewUserPrompt,
  simSystemPrompt,
  simUserPrompt,
  talkSystemPrompt,
  talkUserPrompt,
  type ReviewOutput,
  type SimOutput,
} from './ai/authoring'
import { clearRateLimit, getRateLimit } from './ai/claude'
import { courseIdOfLesson, findLessonMeta, getCharacters, getCourse, getCurriculum, getLesson, listCourses, saveCurriculum, type CurriculumFile } from './content'
import { JsonState, dataFile, generatedLessonKeys, getSettings, lessonKey, lessonRecords, saveGeneratedLesson, saveLessonSim, saveLessonTalk } from './store'
import { getLang, t } from '@shared/i18n'

/**
 * 教材づくり。単元表と授業の本文を AI に書かせる。
 *
 * 使い方は 2 通りある。
 *   その場で 1 つ作る … 教科書モードで、まだ無い授業を開いたとき
 *   まとめて作る     … 全科目を順番に作りつづける。使用量が上限に近づいたら休み、回復したら自動で再開する
 *
 * まとめて作る処理は、アプリを開いている間だけ動く。途中で閉じても、次に開いたときに続きから再開する。
 */

// ───────── 1 つ作る ─────────

const writing = new Map<string, Promise<unknown>>()

/** 同じものへの要求が重なったら、1 回にまとめる */
function once<T>(key: string, work: () => Promise<T>): Promise<T> {
  const running = writing.get(key) as Promise<T> | undefined
  if (running) return running
  const task = work().finally(() => writing.delete(key))
  writing.set(key, task)
  return task
}

/**
 * 教材（日本語の原本）を作る・書きかえる操作は、日本語で表示しているときだけ行う。
 * ほかの言語の教材は、日本語の原本から訳して作る（tools/translate-lessons.mjs と main/translate.ts）。
 */
function sourceOnly(): void {
  if (getLang() !== 'ja') throw new Error(t('教材づくり（授業の作成や、掛け合い・動く図解の追加）は、日本語で表示しているときに行います。設定で言語を日本語に切りかえてください。'))
}

/** 科目の単元表が無ければ、AI に作らせる */
export function ensureCurriculum(courseId: string): Promise<void> {
  sourceOnly()
  return once(`curriculum:${courseId}`, async () => {
    const course = getCourse(courseId)
    if (!course) throw new Error(t('科目が見つかりません。'))
    if (course.hasCurriculum) return
    const output = await askStructured<CurriculumFile>(getSettings().ai, curriculumSystemPrompt(course), curriculumUserPrompt(course), CURRICULUM_SCHEMA)
    const units = (output.units ?? [])
      .map((unit) => ({
        domain: String(unit.domain ?? ''),
        title: String(unit.title ?? '').trim(),
        summary: String(unit.summary ?? '').trim(),
        lessons: (unit.lessons ?? [])
          .map((l) => ({ title: String(l.title ?? '').trim(), summary: String(l.summary ?? '').trim() }))
          .filter((l) => l.title),
      }))
      .filter((unit) => unit.title && unit.lessons.length)
    if (units.length < 2) throw new Error(t('単元表を作れませんでした。もう一度お試しください。'))
    saveCurriculum(courseId, { units })
  })
}

/** 授業の本文を AI に書かせて保存する。review が真なら、書いたものをもう一度 AI に点検させる。 */
export function writeLesson(lessonId: string, variant: LessonVariant, review: boolean): Promise<Lesson> {
  sourceOnly()
  return once(`lesson:${lessonKey(lessonId, variant)}`, async () => {
    const found = findLessonMeta(lessonId)
    if (!found) throw new Error(t('授業が見つかりません。'))
    const { course, unit, lesson } = found
    const wanted: LessonVariant = variant === 'deep' && course.hasDeep ? 'deep' : 'standard'
    const existing = getLesson(lessonId, wanted)
    if (existing) return existing

    const { ai } = getSettings()
    const units = getCurriculum(course.id)?.units ?? []
    const raw = await askText(ai, lessonSystemPrompt(course, wanted), lessonUserPrompt(course, units, unit, lesson))
    // 念のため、全体がコードブロックで包まれて返ってきた場合は外す
    let body = dropPreface(raw.trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, '$1').trim())
    if (body.length < 150) throw new Error(t('授業の作成に失敗しました。もう一度お試しください。'))

    let reviewed = false
    if (review) {
      const result = await askStructured<ReviewOutput>(ai, reviewSystemPrompt(course), reviewUserPrompt(course, unit, lesson, body), REVIEW_SCHEMA)
      // 修正後の本文が極端に短いときは、点検のほうが失敗しているとみなして元の本文を残す
      if (result.verdict === 'fixed' && result.corrected.trim().length > body.length * 0.6) body = result.corrected.trim()
      reviewed = true
    }
    saveGeneratedLesson(lessonId, wanted, body, reviewed)
    return getLesson(lessonId, wanted)!
  })
}

// ───────── 掛け合いを足す ─────────

/**
 * 掛け合いに出る人: 先生と、同級生 2 人。
 * 同じ単元では同じ 2 人が出るように、単元の ID から決める（同級生の一覧の前半と後半から 1 人ずつ）。
 */
export function castFor(unitId: string): CharacterDef[] {
  const all = getCharacters()
  const teacher = all.find((c) => c.role === 'teacher')
  const mates = all.filter((c) => c.role === 'classmate')
  let h = 2166136261
  for (const ch of unitId) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d) >>> 0
  h ^= h >>> 12
  const half = Math.ceil(mates.length / 2)
  const first = mates.slice(0, half)
  const second = mates.slice(half)
  // h は符号つきの数になることがあるので、0 以上の数に直してから割る（負のままだと、1 人目が選ばれない）
  const picked = [first[(h >>> 0) % Math.max(1, first.length)], second[(h >>> 8) % Math.max(1, second.length)]]
  return [teacher, ...picked].filter((c): c is CharacterDef => !!c)
}

const GUEST_NAME = /^[^\s()（）:：、。「」]{1,16}$/

/**
 * AI が返したせりふを確かめて、そのまま使える形にする。
 * 話し手が登場人物でない、長すぎる、数が合わない、などのときは、理由を付けて投げる（その掛け合いは使わない）。
 */
function cleanTalkLines(raw: unknown, cast: CharacterDef[], body: string, guestOk: boolean): TalkLine[] {
  if (!Array.isArray(raw)) throw new Error(t('せりふの並びになっていない'))
  const lines: TalkLine[] = []
  const guests = new Set<string>()
  for (const item of raw as { speaker?: unknown; expression?: unknown; text?: unknown }[]) {
    const named = String(item?.speaker ?? '').trim()
    const text = String(item?.text ?? '').replace(/\s+/g, ' ').trim().replace(/^「(.*)」$/, '$1')
    if (!text) throw new Error(t('空のせりふがある'))
    if (text.length > 200 || text.includes('```')) throw new Error(t('せりふが長すぎるか、書式がくずれている'))
    const person = cast.find((c) => c.id === named || c.name === named || callName(c) === named)
    // 歴史上の人物は「厩戸皇子（聖徳太子）」のように、かっこ書きを付けて返ってくることがあるので、外して調べる
    const guest = named.replace(/[（(][^）)]*[）)]/g, '').replace(/[\s　]+/g, '')
    if (person) {
      const expression = String(item?.expression ?? '').trim()
      lines.push({ speaker: person.id, expression: person.expressions[expression] ? expression : '', text })
    } else if (guestOk && GUEST_NAME.test(guest) && !NO_GUEST.test(guest) && body.includes(guest)) {
      // 本文に名前が出てくる人だけ
      guests.add(guest)
      lines.push({ speaker: guest, expression: '', text })
    } else throw new Error(t('登場人物でない話し手（{0}）', named.slice(0, 20)))
  }
  if (guests.size > 1) throw new Error(t('歴史上の人物が 2 人以上いる'))
  if (lines.length < 2 || lines.length > 6) throw new Error(t('せりふの数が合わない（{0} 個）', lines.length))
  return lines
}

/**
 * できあがっている授業に、掛け合い（導入と、つまずきやすい所の確認）を足す。
 * 本文は書きかえず、AI にはせりふだけを書かせて、決まった位置に差しこむ。redo が真なら、いまの掛け合いを作り直す。
 */
export function addTalk(lessonId: string, variant: LessonVariant, redo = false): Promise<Lesson> {
  sourceOnly()
  return once(`talk:${lessonKey(lessonId, variant)}`, async () => {
    const found = findLessonMeta(lessonId)
    if (!found) throw new Error(t('授業が見つかりません。'))
    const { course, unit, lesson } = found
    const wanted: LessonVariant = variant === 'deep' && course.hasDeep ? 'deep' : 'standard'
    const current = getLesson(lessonId, wanted)
    if (!current) throw new Error(t('この授業の教科書がまだ用意されていません。'))
    if (!allowsTalk(course) || (wanted === 'standard' && lesson.status === 'authored')) throw new Error(t('この授業には、掛け合いを足せません。'))
    if (hasTalk(current.body) && !redo) {
      // すでに入っている（記録だけが無い）ときは、記録を付けて終える
      if (!lessonRecords()[lessonKey(lessonId, wanted)]?.talk) saveLessonTalk(lessonId, wanted, current.body, true)
      return current
    }
    const base = stripTalk(current.body)
    const cast = castFor(unit.id)
    let problem = ''
    // 決まりに合わないものが返ってきたら、1 回だけ書き直させる
    for (let attempt = 0; attempt < 2; attempt++) {
      const output = await askStructured<{ intro: unknown; check: unknown }>(getSettings().ai, talkSystemPrompt(course, wanted, cast), talkUserPrompt(course, unit, lesson, base), TALK_SCHEMA)
      const talk: LessonTalk = { intro: [], check: [] }
      try {
        talk.intro = cleanTalkLines(output.intro, cast, base, allowsGuest(course))
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error)
        continue
      }
      try {
        talk.check = cleanTalkLines(output.check, cast, base, false)
      } catch {
        // つまずきの確認は、無くてもよい（まちがえやすい点が無い授業では、空で返ってくる）
      }
      saveLessonTalk(lessonId, wanted, insertTalk(base, talk), true)
      return getLesson(lessonId, wanted)!
    }
    throw new Error(t('掛け合いを作れませんでした（{0}）。もう一度お試しください。', problem))
  })
}

// ───────── 動く図解を足す ─────────

/**
 * できあがっている授業に、合う「動く図解」があれば 1 つ足す（算数・数学・理科）。
 * AI が決めるのは、どの図解を、どの値から始め、何を確かめさせ、どこに置くかだけ。図の中身はアプリが式から描く。
 * 合うものが無い授業は、「調べたが無かった」と記録して、何度も調べ直さないようにする。redo が真なら、選び直す。
 */
export function addSim(lessonId: string, variant: LessonVariant, redo = false): Promise<{ lesson: Lesson; added: boolean }> {
  sourceOnly()
  return once(`sim:${lessonKey(lessonId, variant)}`, async () => {
    const found = findLessonMeta(lessonId)
    if (!found) throw new Error(t('授業が見つかりません。'))
    const { course, unit, lesson } = found
    const wanted: LessonVariant = variant === 'deep' && course.hasDeep ? 'deep' : 'standard'
    const current = getLesson(lessonId, wanted)
    if (!current) throw new Error(t('この授業の教科書がまだ用意されていません。'))
    const kinds = simsFor(course)
    if (!kinds.length || (wanted === 'standard' && lesson.status === 'authored')) throw new Error(t('この授業には、動く図解を足せません。'))
    if (hasBlock(current.body, 'sim') && !redo) {
      if (!((lessonRecords()[lessonKey(lessonId, wanted)]?.sim ?? 0) > 0)) saveLessonSim(lessonId, wanted, null, true)
      return { lesson: current, added: true }
    }
    const had = hasBlock(current.body, 'sim')
    const base = stripBlocks(current.body, 'sim')
    // 図解を選ぶときは、掛け合いや挿絵を見せない（本文だけで判断させる）
    const plain = stripBlocks(stripTalk(base), 'picture')
    const output = await askStructured<SimOutput>(getSettings().ai, simSystemPrompt(course, wanted, kinds), simUserPrompt(course, unit, lesson, plain), SIM_SCHEMA)
    const none = () => {
      saveLessonSim(lessonId, wanted, had ? base : null, false)
      return { lesson: getLesson(lessonId, wanted)!, added: false }
    }
    if (!kinds.includes(output.kind)) return none()
    const spec = normalizeSim({
      kind: output.kind,
      task: output.task,
      values: Object.fromEntries((output.values ?? []).map((v) => [v.name, v.value])),
      choices: Object.fromEntries((output.choices ?? []).map((c) => [c.name, c.value])),
      expr: output.expr,
      label: output.label,
      range: { xMin: output.xMin, xMax: output.xMax, yMin: output.yMin, yMax: output.yMax },
    })
    if (!spec || spec.task.length < 6) return none()
    if (spec.kind === 'graph') {
      // はじめの値のグラフが、表示する範囲に少しも入らないものは使わない
      const fn = compileGraph(spec.expr!, spec.values)
      const { xMin, xMax, yMin, yMax } = spec.range!
      const visible = Array.from({ length: 41 }, (_, i) => fn(xMin + ((xMax - xMin) * i) / 40)).filter((y) => Number.isFinite(y) && y >= yMin && y <= yMax).length
      if (visible < 5) return none()
    }
    const inserted = insertAfterSection(base, output.after, formatSim(spec))
    if (!inserted) return none()
    saveLessonSim(lessonId, wanted, inserted, true)
    return { lesson: getLesson(lessonId, wanted)!, added: true }
  })
}

// ───────── まとめて作る ─────────

interface Stored {
  enabled: boolean
  options: LibraryOptions
  priority: string[]
}

const DEFAULT_OPTIONS: LibraryOptions = { review: true, pauseAt: 0.8, concurrency: 2, talk: false, sims: false }
/** 同時に作る数の上限 */
const MAX_CONCURRENCY = 30
/**
 * 作りはじめを、この間隔でずらす。
 * 同時に作る数が多いと、始めたときや休みが明けたときに、全員が一斉に AI を呼んで断られやすいため。
 * （1 つの授業に 30 秒以上かかるので、30 個を同時に作っていても、この間隔が進みを遅らせることはない）
 */
const START_GAP_MS = 500
/** 1 週間あたりの使用量は、この割合で休む（週の上限を使い切らないようにする） */
const WEEKLY_PAUSE_AT = 0.9

const stored = new JsonState<Stored>(() => dataFile('library.json'), () => ({ enabled: false, options: DEFAULT_OPTIONS, priority: [] }))

type Task =
  | { kind: 'curriculum'; courseId: string; label: string }
  | { kind: 'lesson'; lessonId: string; variant: LessonVariant; label: string }
  | { kind: 'talk'; lessonId: string; variant: LessonVariant; label: string }
  | { kind: 'sim'; lessonId: string; variant: LessonVariant; label: string }
const keyOf = (task: Task) => (task.kind === 'curriculum' ? `c:${task.courseId}` : `${task.kind[0]}:${lessonKey(task.lessonId, task.variant)}`)

let status: LibraryState['status'] = 'idle'
/** 休止中か。（関数ごしに読む: 直前の代入から型が決めつけられて、比較が誤りと判定されるのを避ける）*/
const isPaused = () => status === 'paused'
let pauseReason: string | null = null
let resumeAt: number | null = null
let running = false
const current = new Map<string, string>()
const recent: LibraryState['recent'] = []
/** 今回の実行で失敗したもの。同じものを何度もやり直して使用量を浪費しないよう、次に始めるまで飛ばす。 */
const failed = new Set<string>()
let notify: () => void = () => undefined
let failuresInRow = 0

function log(text: string, ok: boolean): void {
  recent.unshift({ at: Date.now(), text, ok })
  recent.length = Math.min(recent.length, 40)
}

function options(): LibraryOptions {
  return { ...DEFAULT_OPTIONS, ...stored.get().options }
}

/** いま、同時にいくつ作ることになっているか */
const wantedWorkers = () => Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(options().concurrency)))

/**
 * 上限に達して、AI に断られている状態か。
 * 「allowed_warning」（上限が近いという知らせ）は、まだ使える状態なので、達したとはみなさない。
 * （ここで休んでしまうと、「100% まで使う」設定にしても、その手前で止まってしまう）
 */
const isRejected = () => {
  const limit = getRateLimit()
  return !!limit && !limit.status.startsWith('allowed')
}

/**
 * 本文の前に付いた、モデルの前置きを外す。最初の「# 」の見出しから後ろを本文とする。
 * モデルによっては、本文の前に印（[…] や <…>…</…>）や、考えのメモを出すことがある（Fable 5.2 で見られた）。
 * 前置きにしては長いものや、見出し・コードブロックをふくむものは、本文の一部かもしれないので、さわらない。
 */
export function dropPreface(text: string): string {
  const body = text.replace(/^(?:\s*(?:<([a-z_]{1,30})>[^<\n]{0,60}<\/\1>|\[[^\]\n]{1,40}\]))+\s*(?=# )/, '')
  const at = body.search(/^# \S/m)
  if (at <= 0) return body
  const before = body.slice(0, at)
  return before.length <= 3000 && !/^## |```/m.test(before) ? body.slice(at) : body
}

/** 上限に達したとき、いつまで休めばよいか */
function limitResetsAt(): number {
  const limit = getRateLimit()
  if (limit?.sevenDay && limit.sevenDay.utilization >= 1) return limit.sevenDay.resetsAt
  // 5 時間の枠にまだ余裕があるのに断られたときは、一時的な混雑とみて、少しだけ休む
  // （同時に作る数が多いと、短い時間に集中しすぎて断られることがある。回復の時刻まで何時間も休む必要はない）
  if (limit?.fiveHour && !isRejected() && limit.fiveHour.utilization < 0.95) return Date.now() + 5 * 60_000
  return limit?.fiveHour?.resetsAt ?? Date.now() + 30 * 60_000
}

/** 科目を、先に作ると指定されたものから順に並べる */
function orderedCourses() {
  const courses = listCourses()
  const first = stored.get().priority.flatMap((id) => courses.filter((c) => c.id === id))
  return [...first, ...courses.filter((c) => !first.includes(c))]
}

/** 次に作るものを選ぶ。ふつうの本文をすべての科目で作り終えてから、小学校の学び直し向けの本文に進む。 */
function nextTask(): Task | null {
  const taken = (task: Task) => current.has(keyOf(task)) || failed.has(keyOf(task))
  const generated = generatedLessonKeys()
  const courses = orderedCourses()
  const chosen = new Set(stored.get().priority)
  for (const variant of ['standard', 'deep'] as const) {
    for (const course of courses) {
      // 大学・大学院は試作。「先に作る」を押した科目だけを作る
      // （科目を足しただけで、知らないうちに何百回ぶんもの使用量を使いはじめないように）
      if (course.higher && !chosen.has(course.id)) continue
      if (variant === 'deep' && !course.hasDeep) continue
      if (!course.hasCurriculum) {
        const task: Task = { kind: 'curriculum', courseId: course.id, label: t('{0} の単元表', course.title) }
        if (variant === 'standard' && !taken(task)) return task
        continue
      }
      if (variant === 'standard' && course.ready >= course.total) continue
      for (const unit of getCurriculum(course.id)?.units ?? []) {
        for (const lesson of unit.lessons) {
          const done = variant === 'deep' ? generated.has(lessonKey(lesson.id, 'deep')) : lesson.status !== 'none'
          if (done) continue
          const label = `${course.title} ${lesson.number} ${lesson.title}${variant === 'deep' ? t('（学び直し向け）') : ''}`
          const task: Task = { kind: 'lesson', lessonId: lesson.id, variant, label }
          if (!taken(task)) return task
        }
      }
    }
  }
  // 授業をすべて作り終えたら、掛け合い・動く図解を足していく（設定で有効にしているときだけ）
  return (options().talk ? nextExtraTask('talk', courses, taken) : null) ?? (options().sims ? nextExtraTask('sim', courses, taken) : null)
}

/** 足し終えた科目（今回の実行の間だけ覚えておいて、何度も調べ直さないようにする）。「talk:科目」「sim:科目」の形 */
const talkedCourses = new Set<string>()

/** 掛け合い（talk）や動く図解（sim）を、まだ足していない（調べていない）授業を選ぶ */
function nextExtraTask(kind: 'talk' | 'sim', courses: Course[], taken: (task: Task) => boolean): Task | null {
  const records = lessonRecords()
  for (const course of courses) {
    const mark = `${kind}:${course.id}`
    if (talkedCourses.has(mark) || !course.hasCurriculum || !(kind === 'talk' ? allowsTalk(course) : simsFor(course).length > 0)) continue
    let remaining = false
    for (const unit of getCurriculum(course.id)?.units ?? []) {
      for (const lesson of unit.lessons) {
        const variants: LessonVariant[] = [...(lesson.status === 'generated' ? (['standard'] as const) : []), ...(lesson.deep ? (['deep'] as const) : [])]
        for (const variant of variants) {
          if (records[lessonKey(lesson.id, variant)]?.[kind]) continue
          remaining = true
          const task: Task = { kind, lessonId: lesson.id, variant, label: t('{0} {1} {2}{3} の{4}', course.title, lesson.number, lesson.title, variant === 'deep' ? t('（学び直し向け）') : '', kind === 'talk' ? t('掛け合い') : t('動く図解')) }
          if (!taken(task)) return task
        }
      }
    }
    if (!remaining) talkedCourses.add(mark)
  }
  return null
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 作成している間は、PC が自動でスリープしないようにする（画面が消えるのは止めない）。
 * 何日もかかる作業なので、スリープのたびに止まるとほとんど進まないため。休んでいる間は解除する。
 */
let awake: number | null = null
function keepAwake(on: boolean): void {
  if (on && awake === null) awake = powerSaveBlocker.start('prevent-app-suspension')
  if (!on && awake !== null) {
    powerSaveBlocker.stop(awake)
    awake = null
  }
}

/** 使用量が上限に近いときは、回復する時刻まで休む。休んだら true。 */
async function restIfNeeded(): Promise<boolean> {
  const limit = getRateLimit()
  if (!limit) return false
  const { pauseAt } = options()
  let until = 0
  let reason = ''
  if (isRejected()) {
    until = limitResetsAt()
    reason = t('使用量の上限に達したため')
  } else if (limit.sevenDay && limit.sevenDay.utilization >= WEEKLY_PAUSE_AT) {
    until = limit.sevenDay.resetsAt
    reason = t('1 週間の使用量が {0}% に達したため', Math.round(limit.sevenDay.utilization * 100))
  } else if (limit.fiveHour && limit.fiveHour.utilization >= pauseAt) {
    until = limit.fiveHour.resetsAt
    reason = t('5 時間あたりの使用量が {0}% に達したため', Math.round(limit.fiveHour.utilization * 100))
  }
  if (!until) return false
  await rest(until + 60_000, reason)
  return true
}

async function rest(until: number, reason: string): Promise<void> {
  status = 'paused'
  keepAwake(false)
  pauseReason = reason
  resumeAt = until
  log(t('{0}、作成を休みます。', reason), true)
  notify()
  while (stored.get().enabled && Date.now() < until) await sleep(15_000)
  // 休む前の値が残っていると、明けた直後にまた休んでしまうので忘れる
  clearRateLimit()
  // 休みに入るときに作りかけだったぶんの失敗も数えられているので、数えなおす
  // （同時に作る数が多いと、ここが 4 を超えたままになり、明けた直後の 1 回の失敗でまた休んでしまう）
  failuresInRow = 0
  pauseReason = null
  resumeAt = null
  status = stored.get().enabled ? 'running' : 'idle'
  keepAwake(status === 'running')
  notify()
}

async function perform(task: Task): Promise<void> {
  if (task.kind === 'curriculum') await ensureCurriculum(task.courseId)
  else if (task.kind === 'talk') await addTalk(task.lessonId, task.variant)
  else if (task.kind === 'sim') await addSim(task.lessonId, task.variant)
  else await writeLesson(task.lessonId, task.variant, options().review)
}

/** いま動いている作り手の数 */
let active = 0
let pool: Promise<void>[] = []

/** 次に作りはじめてよい時刻 */
let nextStartAt = 0

/** 作りはじめる順番を待つ（作り手どうしで、START_GAP_MS ずつずらす） */
async function takeTurn(): Promise<void> {
  const at = Math.max(Date.now(), nextStartAt)
  nextStartAt = at + START_GAP_MS
  if (at > Date.now()) await sleep(at - Date.now())
}

/** 「同時に作る数」に足りないぶんの作り手を、動かしはじめる（作っている途中で数を増やしたときにも呼ぶ） */
function topUp(): void {
  // worker() は、最初の await までその場で進むので、呼んだ直後には active が増えている
  while (active < wantedWorkers()) pool.push(worker())
}

async function worker(): Promise<void> {
  active += 1
  try {
    await work()
  } finally {
    active -= 1
  }
}

async function work(): Promise<void> {
  // 途中で「同時に作る数」を減らされたら、余ったぶんは、いまの 1 つを作り終えたところで終わる
  while (stored.get().enabled && active <= wantedWorkers()) {
    if (isPaused()) {
      await sleep(5_000)
      continue
    }
    await takeTurn()
    // 順番を待っている間に、止められたり、休みに入ったり、数を減らされたりしていたら、作りはじめない
    if (!stored.get().enabled || isPaused() || active > wantedWorkers()) continue
    const task = nextTask()
    if (!task) return
    const key = keyOf(task)
    current.set(key, task.label)
    notify()
    try {
      await perform(task)
      failuresInRow = 0
      log(task.label, true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.add(key)
      failuresInRow += 1
      log(t('{0} — 作れませんでした: {1}', task.label, message.slice(0, 120)), false)
      // 上限に達したときや、失敗が続くときは、しばらく休む（使用量の通知が無い codex でも止まれるように）
      // （「rate」だけで調べると generate などの言葉にも当てはまってしまうので、limit・quota・429 で見分ける）
      const limited = /limit|quota|429|overloaded|上限/i.test(message) || isRejected()
      if (limited || failuresInRow >= 4) {
        // 上限のせいで作れなかったものは、休みが明けたらやり直す（同時に作っていたほかのぶんも同じ）
        failed.delete(key)
        if (!isPaused()) {
          failuresInRow = 0
          current.delete(key)
          await rest(limited ? limitResetsAt() : Date.now() + 30 * 60_000, limited ? t('使用量の上限に達したため') : t('失敗が続いたため'))
          continue
        }
      }
    } finally {
      current.delete(key)
      notify()
    }
    if (!isPaused()) await restIfNeeded()
  }
}

async function run(): Promise<void> {
  // まとめて作るのは、日本語で表示しているときだけ（ほかの言語のときは、止まったままにする）
  if (running || getLang() !== 'ja') return
  running = true
  status = 'running'
  keepAwake(true)
  failed.clear()
  talkedCourses.clear()
  notify()
  try {
    pool = []
    topUp()
    // 途中で「同時に作る数」が増やされると、pool に足される。すべてが終わるまで待つ
    for (let i = 0; i < pool.length; i++) await pool[i]
  } finally {
    running = false
    keepAwake(false)
    // 作るものが残っていないのに有効のまま終わった = すべて完成
    status = stored.get().enabled && !nextTask() ? 'done' : 'idle'
    notify()
  }
}

/** 起動時に呼ぶ。前回「まとめて作る」を有効にしたままなら、続きから再開する。 */
export function startLibrary(onChange: () => void): void {
  notify = onChange
  if (stored.get().enabled) void run()
}

export function setLibraryEnabled(enabled: boolean): void {
  stored.update((s) => ({ ...s, enabled }))
  if (enabled) void run()
  else if (status !== 'running') status = 'idle'
  notify()
}

export function setLibraryOptions(patch: Partial<LibraryOptions>): void {
  const next = { ...options(), ...patch }
  // pauseAt が 1（100%）のときは、上限に達して断られるまで作りつづける
  next.pauseAt = Math.max(0.3, Math.min(1, Number(next.pauseAt) || DEFAULT_OPTIONS.pauseAt))
  next.concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(Number(next.concurrency) || 1)))
  next.review = !!next.review
  next.talk = !!next.talk
  next.sims = !!next.sims
  stored.update((s) => ({ ...s, options: next }))
  // 作っている途中で数を増やしたら、すぐに作り手を足す
  if (running) topUp()
  // すべて作り終えて止まっているときに「掛け合いを足す」「動く図解を足す」を有効にされたら、続きを始める
  else if (stored.get().enabled) void run()
  notify()
}

/** 指定した科目を、先に作る */
export function prioritizeCourse(courseId: string): void {
  stored.update((s) => ({ ...s, priority: [courseId, ...s.priority.filter((id) => id !== courseId)].slice(0, 20) }))
  notify()
}

/** 掛け合い・動く図解が入っている授業の数と、足せる授業（AI が作った本文）の数 */
function talkTotals(courses: Course[]) {
  const records = lessonRecords()
  const noTalk = new Set(courses.filter((c) => !allowsTalk(c)).map((c) => c.id))
  const withSims = new Set(courses.filter((c) => simsFor(c).length > 0).map((c) => c.id))
  const totals = { talks: 0, talkTargets: 0, sims: 0, simChecked: 0, simTargets: 0 }
  for (const key of generatedLessonKeys()) {
    const courseId = courseIdOfLesson(key.replace(/\.deep$/, ''))
    if (!noTalk.has(courseId)) {
      totals.talkTargets += 1
      if (records[key]?.talk) totals.talks += 1
    }
    if (withSims.has(courseId)) {
      totals.simTargets += 1
      if (records[key]?.sim) totals.simChecked += 1
      if ((records[key]?.sim ?? 0) > 0) totals.sims += 1
    }
  }
  return totals
}

export function getLibraryState(): LibraryState {
  // 合計に数えるのは、まとめて作る対象の科目だけ（大学・大学院は、「先に作る」を押した科目だけ）
  const chosen = new Set(stored.get().priority)
  const courses = listCourses().filter((c) => !c.higher || chosen.has(c.id))
  const limit = getRateLimit()
  return {
    enabled: stored.get().enabled,
    status,
    pauseReason,
    resumeAt,
    options: options(),
    current: [...current.values()],
    recent: recent.slice(0, 20),
    usage: { fiveHour: limit?.fiveHour ?? null, sevenDay: limit?.sevenDay ?? null },
    priority: stored.get().priority,
    totals: {
      courses: courses.length,
      curricula: courses.filter((c) => c.hasCurriculum).length,
      lessons: courses.reduce((sum, c) => sum + c.total, 0),
      ready: courses.reduce((sum, c) => sum + c.ready, 0),
      ...talkTotals(courses),
    },
  }
}
