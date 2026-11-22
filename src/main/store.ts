import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { inkStamp } from '@shared/types'
import type {
  ChatLog,
  ExternalReview,
  LessonVariant,
  NoteEvaluation,
  Notebook,
  NotebookSummary,
  NotePage,
  Ruling,
  Settings,
} from '@shared/types'
import { dataDir, safeId } from './paths'

// ───────── JSON ファイルの読み書き ─────────

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

const queues = new Map<string, Promise<void>>()

/** 一時ファイルに書いてから置き換える。同じファイルへの書き込みは順番に行う。 */
function writeJson(file: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value)
  const prev = queues.get(file) ?? Promise.resolve()
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, file)
    })
  queues.set(file, next)
  return next
}

/** 終了前に、書き込み待ちがすべて終わるのを待つ */
export function flushWrites(): Promise<unknown> {
  return Promise.allSettled([...queues.values()])
}

/**
 * 1 つの JSON ファイルにまとめて持つ小さな状態（好感度、利用時間、週ごとの評価など）。
 * 読み込みは最初の 1 回だけにして、以後はメモリ上の値を正とする。
 * （書き込みは非同期なので、毎回ファイルから読むと、直前の変更がまだ書かれておらず失われることがある）
 */
export class JsonState<T> {
  private value: T | undefined

  /**
   * @param sync 真なら、変更のたびに、その場でファイルへ書き終える（少し遅いが、書きもらさない）。
   *             何日もかけて少しずつ増える記録（授業の点検の記録など）に使う。
   */
  constructor(
    private readonly file: () => string,
    private readonly fallback: () => T,
    private readonly sync = false,
  ) {}

  get(): T {
    if (this.value === undefined) this.value = readJson<T>(this.file(), this.fallback())
    return this.value
  }

  set(value: T): void {
    this.value = value
    if (!this.sync) return void writeJson(this.file(), value)
    // 一時ファイルに書いてから置き換える（書いている途中で止まっても、元のファイルがこわれない）
    const tmp = `${this.file()}.tmp`
    writeFileSync(tmp, JSON.stringify(value), 'utf8')
    renameSync(tmp, this.file())
  }

  update(change: (current: T) => T): T {
    const next = change(this.get())
    this.set(next)
    return next
  }
}

export function dataFile(...parts: string[]): string {
  const dir = parts.length > 1 ? dataDir(...parts.slice(0, -1)) : dataDir()
  return join(dir, parts[parts.length - 1])
}

export { readJson, writeJson }

// ───────── 設定 ─────────

export const DEFAULT_RULING: Ruling = { kind: 'lined', spacing: 7 }

const DEFAULT_SETTINGS: Settings = {
  ai: { provider: 'claude', model: 'sonnet', effort: 'medium' },
  characterId: 'sensei',
  courseId: 'jhs1-math',
  ruling: DEFAULT_RULING,
  characterOverrides: {},
  zoom: {},
  keys: {},
  speechModel: 'turbo',
  eikaiwa: { tts: true, unlimited: false, showJa: true },
  language: 'ja',
  furigana: true,
  handedness: 'right',
}

const settingsFile = () => join(dataDir(), 'settings.json')

export function getSettings(): Settings {
  const saved = readJson<Partial<Settings>>(settingsFile(), {})
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    ai: { ...DEFAULT_SETTINGS.ai, ...saved.ai },
    ruling: { ...DEFAULT_SETTINGS.ruling, ...saved.ruling },
    characterOverrides: { ...saved.characterOverrides },
    eikaiwa: { ...DEFAULT_SETTINGS.eikaiwa, ...saved.eikaiwa },
    zoom: { ...saved.zoom },
    keys: { ...saved.keys },
  }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

/**
 * 登場人物を入れ替えたときの、古い ID → 新しい ID（2026-11: 先生役をエレン先生から みのり先生に替えた）。
 * 起動時に、古い ID で残っている設定と会話の記録を、新しい ID に移す。
 */
const RETIRED_CHARACTERS: Record<string, string> = { ellen: 'sensei' }

export function migrateCharacters(): void {
  const saved = readJson<Partial<Settings>>(settingsFile(), {})
  const patch: Partial<Settings> = {}
  if (saved.characterId && RETIRED_CHARACTERS[saved.characterId]) patch.characterId = RETIRED_CHARACTERS[saved.characterId]
  // 前の人物に付けた名前や口調の書きかえは、新しい人物には引きつがない
  const overrides = Object.entries(saved.characterOverrides ?? {})
  if (overrides.some(([id]) => id in RETIRED_CHARACTERS)) patch.characterOverrides = Object.fromEntries(overrides.filter(([id]) => !(id in RETIRED_CHARACTERS)))
  if (Object.keys(patch).length) setSettings(patch)

  const root = dataDir('chats')
  for (const channel of readdirSync(root)) {
    for (const [from, to] of Object.entries(RETIRED_CHARACTERS)) {
      const old = join(root, channel, `${from}.json`)
      if (!existsSync(old)) continue
      const next = join(root, channel, `${to}.json`)
      const log = readJson<ChatLog | null>(old, null)
      if (log && !existsSync(next)) writeFileSync(next, JSON.stringify({ ...log, characterId: to }), 'utf8')
      rmSync(old)
    }
  }
}

// ───────── ディベートの記録 ─────────

const chatFile = (lessonId: string, characterId: string) =>
  join(dataDir('chats', safeId(lessonId)), `${safeId(characterId)}.json`)

export function getChat(lessonId: string, characterId: string): ChatLog {
  return readJson<ChatLog>(chatFile(lessonId, characterId), { lessonId, characterId, messages: [] })
}

export function saveChat(log: ChatLog): Promise<void> {
  return writeJson(chatFile(log.lessonId, log.characterId), log)
}

/** ある授業について、すべての相手との会話を集める（ノートの評価で使う） */
export function getChatsForLesson(lessonId: string): ChatLog[] {
  const dir = dataDir('chats', safeId(lessonId))
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson<ChatLog | null>(join(dir, f), null))
    .filter((log): log is ChatLog => !!log && log.messages.length > 0)
}

// ───────── ノート ─────────

const notebookFile = (id: string) => join(dataDir('notebooks'), `${safeId(id)}.json`)

export function newPage(): NotePage {
  return { id: randomUUID(), strokes: [], texts: [] }
}

export function getNotebook(id: string): Notebook | null {
  return readJson<Notebook | null>(notebookFile(id), null)
}

export function saveNotebook(notebook: Notebook): Promise<void> {
  return writeJson(notebookFile(notebook.id), { ...notebook, updatedAt: Date.now() })
}

/** 一覧の 1 件ぶんを、ファイルが変わるまで覚えておく（ノートを保存するたびに一覧が読み直されるので、全部のノートを読んで手書きの指紋を数え直すと重い） */
const summaryCache = new Map<string, { stamp: number; summary: NotebookSummary }>()

export function listNotebooks(): NotebookSummary[] {
  const dir = dataDir('notebooks')
  const names = readdirSync(dir).filter((f) => f.endsWith('.json'))
  const out: NotebookSummary[] = []
  for (const name of names) {
    const file = join(dir, name)
    let stamp = 0
    try {
      stamp = statSync(file).mtimeMs
    } catch {
      // 時刻が読めないときは、覚えたものを使わずに読み直す
    }
    const cached = summaryCache.get(name)
    if (stamp && cached?.stamp === stamp) {
      out.push(cached.summary)
      continue
    }
    const n = readJson<Notebook | null>(file, null)
    if (!n) continue
    const summary: NotebookSummary = {
      id: n.id,
      title: n.title,
      lessonId: n.lessonId,
      kind: n.kind ?? ('lesson' as NotebookSummary['kind']),
      pageCount: n.pages.length,
      updatedAt: n.updatedAt,
      inkPages: n.pages.filter((p) => p.strokes.length > 0).length,
      transcribedPages: n.pages.filter((p) => p.strokes.length > 0 && p.transcriptStamp === inkStamp(p)).length,
    }
    summaryCache.set(name, { stamp, summary })
    out.push(summary)
  }
  for (const name of [...summaryCache.keys()]) if (!names.includes(name)) summaryCache.delete(name)
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 見開き 1 つ分（2 ページ）の新しいノートを作る */
export async function createNotebook(
  title: string,
  lessonId: string | null,
  kind: NonNullable<Notebook['kind']>,
  extra: Partial<Notebook> = {},
): Promise<Notebook> {
  const now = Date.now()
  const notebook: Notebook = {
    id: randomUUID(),
    title,
    lessonId,
    kind,
    ruling: getSettings().ruling,
    pages: [newPage(), newPage()],
    createdAt: now,
    updatedAt: now,
    ...extra,
  }
  await saveNotebook(notebook)
  return notebook
}

/** メモ（授業と関係なく使うノート）を消す。メモ以外は消さない。 */
export function deleteMemo(id: string): boolean {
  const notebook = getNotebook(id)
  if (!notebook || notebook.kind !== 'memo') return false
  rmSync(notebookFile(id), { force: true })
  return true
}

/**
 * 文字起こしの結果だけを、保存してあるノートに書きこむ（まとめて文字起こしするときに使う）。
 * ページは ID で探し、文字起こしをしたときと線が変わっていないページにだけ書く。
 */
export async function saveTranscripts(id: string, results: { pageId: string; stamp: string; text: string }[]): Promise<number> {
  const notebook = getNotebook(id)
  if (!notebook) return 0
  let written = 0
  const pages = notebook.pages.map((page) => {
    const found = results.find((r) => r.pageId === page.id)
    if (!found || inkStamp(page) !== found.stamp) return page
    written += 1
    return { ...page, transcript: found.text, transcriptStamp: found.stamp }
  })
  if (written) await writeJson(notebookFile(id), { ...notebook, pages })
  return written
}

/** 授業に対応するノートを返す。無ければ新しく作る。 */
export async function ensureNotebook(lessonId: string | null, title: string): Promise<Notebook> {
  const found = listNotebooks().find((n) => n.kind === 'lesson' && n.lessonId === lessonId)
  const existing = found && getNotebook(found.id)
  return existing || createNotebook(title, lessonId, 'lesson')
}

// ───────── ノートの評価 ─────────

const evaluationFile = (notebookId: string) => join(dataDir('evaluations'), `${safeId(notebookId)}.json`)

export function getEvaluations(notebookId: string): NoteEvaluation[] {
  return readJson<NoteEvaluation[]>(evaluationFile(notebookId), [])
}

export function addEvaluation(evaluation: NoteEvaluation): Promise<void> {
  return writeJson(evaluationFile(evaluation.notebookId), [evaluation, ...getEvaluations(evaluation.notebookId)])
}

/** すべてのノートの評価（週ごとの評価を出すときに使う） */
export function getAllEvaluations(): NoteEvaluation[] {
  const dir = dataDir('evaluations')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => readJson<NoteEvaluation[]>(join(dir, f), []))
}

// ───────── AI が生成した授業と単元表 ─────────

/** 保存に使う名前。学び直し向け（深掘り）の本文は、同じ授業の ID に「.deep」を付けて区別する。 */
export const lessonKey = (lessonId: string, variant: LessonVariant = 'standard') =>
  variant === 'deep' ? `${safeId(lessonId)}.deep` : safeId(lessonId)

const generatedLessonFile = (key: string) => join(dataDir('lessons'), `${key}.md`)

/** 生成済みの授業の一覧。科目ごとの進み具合を数えるたびにフォルダを読まないよう、覚えておく。 */
let generatedKeys: Set<string> | null = null

export function generatedLessonKeys(): Set<string> {
  generatedKeys ??= new Set(
    readdirSync(dataDir('lessons'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3)),
  )
  return generatedKeys
}

/** 生成した授業ごとの記録（点検を済ませたかどうか） */
const lessonNotes = new JsonState<Record<string, { at: number; reviewed: boolean; talk?: number; sim?: number }>>(() => dataFile('lessons-index.json'), () => ({}), true)

export function getGeneratedLesson(
  lessonId: string,
  variant: LessonVariant = 'standard',
): { body: string; reviewed: boolean; externalReview?: ExternalReview } | null {
  const key = lessonKey(lessonId, variant)
  if (!generatedLessonKeys().has(key)) return null
  // 精査の記録は、アプリの外（codex など）が書くので、開くたびにファイルから読む
  const externalReview = readJson<ExternalReview | null>(join(dataDir('lessons'), `${key}.review.json`), null) ?? undefined
  // AI が、見出しに授業の番号まで書くことがある（「# 1-3 加法」）。画面の上にも番号が出るので、重ならないよう外す
  const body = readFileSync(generatedLessonFile(key), 'utf8').replace(/^# \d+-\d+[ 　]+/, '# ')
  return { body, reviewed: lessonNotes.get()[key]?.reviewed ?? false, externalReview }
}

export function saveGeneratedLesson(lessonId: string, variant: LessonVariant, body: string, reviewed: boolean): void {
  const key = lessonKey(lessonId, variant)
  writeFileSync(generatedLessonFile(key), body, 'utf8')
  generatedLessonKeys().add(key)
  lessonNotes.update((notes) => ({ ...notes, [key]: { at: Date.now(), reviewed } }))
}

/** 生成した授業ごとの記録（保存名 → 記録）。talk は、掛け合いを足した時刻。sim は、動く図解を足した時刻（調べたが合うものが無かったときは -1） */
export const lessonRecords = () => lessonNotes.get()

/** 掛け合いを差しこんだ（または取り除いた）本文を保存する。点検の記録は変えない */
export function saveLessonTalk(lessonId: string, variant: LessonVariant, body: string, has: boolean): void {
  const key = lessonKey(lessonId, variant)
  writeFileSync(generatedLessonFile(key), body, 'utf8')
  lessonNotes.update((notes) => {
    const { talk: _old, ...rest } = notes[key] ?? { at: Date.now(), reviewed: false }
    return { ...notes, [key]: has ? { ...rest, talk: Date.now() } : rest }
  })
}

/** 動く図解を調べた結果を記録する。body を渡したときは、図解を差しこんだ（または取りのぞいた）本文も保存する */
export function saveLessonSim(lessonId: string, variant: LessonVariant, body: string | null, added: boolean): void {
  const key = lessonKey(lessonId, variant)
  if (body !== null) writeFileSync(generatedLessonFile(key), body, 'utf8')
  lessonNotes.update((notes) => ({ ...notes, [key]: { ...(notes[key] ?? { at: Date.now(), reviewed: false }), sim: added ? Date.now() : -1 } }))
}

const curriculumFile = (courseId: string) => join(dataDir('curricula'), `${safeId(courseId)}.json`)

export function getGeneratedCurriculum<T>(courseId: string): T | null {
  return readJson<T | null>(curriculumFile(courseId), null)
}

export function saveGeneratedCurriculum(courseId: string, value: unknown): void {
  writeFileSync(curriculumFile(courseId), JSON.stringify(value, null, 1), 'utf8')
}
