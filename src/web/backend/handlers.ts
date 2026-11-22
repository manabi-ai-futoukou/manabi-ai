/**
 * 画面からの要求に答えるところ（Web 版）。Electron 版の src/main/index.ts の registerHandlers にあたる。
 *
 * 中身は、Electron 版と同じ部品（src/main の content・store・test・kanji など）をそのまま呼ぶ。ちがうのは次の点だけ。
 * - ウィンドウは無い。画面を開く・閉じるは、親のページ（src/web/shell.tsx）に頼む
 * - AI は、コマンドではなく通信で呼ぶ（src/web/ai/）
 * - この PC の中の道具に頼っていた機能（音声の文字起こし、読み上げの予備、動画づくり）は、「使えない」と答える
 */
// 表示する言語は、ほかのモジュールが文言を決める前に設定する
import '../../main/lang'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getLang, isLang, t } from '@shared/i18n'
import { KEY_ACTIONS, clampZoom } from '@shared/keys'
import {
  COACH_CHANNEL,
  EIKAIWA_CHANNEL,
  type CharacterOverride,
  type DebateSetup,
  type EssayReviewRequest,
  type EvaluateRequest,
  type GlossaryQuery,
  type KanjiSetup,
  type LessonVariant,
  type LibraryOptions,
  type Notebook,
  type SearchQuery,
  type Settings,
  type SpeechStatus,
  type TestSetup,
  type ViewName,
  type ViewParams,
  type VocabLang,
} from '@shared/types'
import { aiStatus, clearChat, coach, evaluateNote, resetSessions, sendChat, sendCoach, transcribeNote } from '../../main/ai'
import { getAnnotation, getGlossaryTerm, getLessonLinks, getTimeline, lessonHits, listGlossary, makeAnnotation, runSearch, type RawLessonHit } from '../../main/annot'
import { findSnippets, searchPattern } from '../../shared/search'
import { attachmentDataUrl } from '../../main/attachments'
import { DEFAULT_COURSE_ID, findLessonMeta, getCharacters, getCurriculum, getLesson, listCourses, personNames, subjectOfLesson } from '../../main/content'
import { advanceDebate, debateBrief, getDebate, listDebates, startDebate, suggestTopic } from '../../main/debate'
import { eikaiwaLevel, sayInEikaiwa, toEnglish } from '../../main/eikaiwa'
import { getEssaySet, listEssayAttempts, makeEssaySet, reviewEssay } from '../../main/essay'
import { clearKanji, kanjiCount, kanjiState, reportKanjiWritten, retryKanjiWords, skipKanji, startKanji, stopKanji } from '../../main/kanji'
import { addSim, addTalk, ensureCurriculum, getLibraryState, prioritizeCourse, setLibraryEnabled, setLibraryOptions, writeLesson } from '../../main/library'
import { getPerson, getPicture } from '../../main/media'
import { dataDir, safeId } from '../../main/paths'
import { buildPdf } from '../../main/pdf'
import { activeSubjects, commentOnWeek, listReports, settleWeeks } from '../../main/report'
import { getSkills } from '../../main/skills'
import { createNotebook, deleteMemo, ensureNotebook, flushWrites, getChat, getEvaluations, getNotebook, getSettings, listNotebooks, migrateCharacters, saveNotebook, saveTranscripts, setSettings } from '../../main/store'
import { abortTest, getActiveTest, getTestResult, listTestResults, startTest, submitTest } from '../../main/test'
import { translateLesson } from '../../main/translate'
import { startUsageTracking } from '../../main/usage'
import { checkVocab, setVocabMode, skipVocab, startVocab, stopVocab, vocabState } from '../../main/vocab'
import { allowedRoutes, available, getAiConfig, getUsageRows, setAiConfig, setAllowedRoutes, setTask, type Route, type WebAiConfig } from '../ai/transport'
import { setIdleSeconds } from '../shims/electron'
import { clearFs, flushFs, localUsage } from '../shims/fs'

/** 要求を出した画面 */
export interface Ctx {
  key: string
  view: ViewName
  params: ViewParams
}
type Handler = (ctx: Ctx, ...args: any[]) => unknown
const handlers = new Map<string, Handler>()
const handle = (channel: string, fn: Handler) => handlers.set(channel, fn)

const post = (message: unknown) => (self as unknown as { postMessage(message: unknown): void }).postMessage(message)
/** すべての画面に、変わったことを知らせる */
const broadcast = (...topics: string[]) => topics.forEach((topic) => post({ type: 'event', channel: 'changed', payload: topic }))
/** 親のページに、画面を開く・閉じるなどを頼む */
const shell = (op: string, extra: Record<string, unknown> = {}) => post({ type: 'shell', op, ...extra })

const VIEW_NAMES: ViewName[] = ['home', 'textbook', 'chat', 'debate', 'note', 'memo', 'glossary', 'search', 'timeline', 'essay', 'test', 'report', 'library', 'eikaiwa', 'vocab', 'kanji', 'kanjiOrder', 'kanjiNote', 'settings', 'video']
const STUDY_VIEWS: ViewName[] = ['textbook', 'chat', 'note', 'test']
const WEB_ONLY = () => new Error(t('この機能は、Web 版ではまだ使えません。'))

function allowedDuringTest(view: ViewName, params: ViewParams): boolean {
  const active = getActiveTest()
  if (!active) return true
  return view === 'test' || view === 'settings' || (view === 'note' && params.notebookId === active.notebookId)
}

// ───────── 付属のサーバーの様子（どの AI につなげるか） ─────────

interface ServerStatus {
  claude: boolean
  codex: boolean
  keys: { claude: boolean; openai: boolean }
  siwc: boolean
}
let base = '/'
let serverStatus: ServerStatus | null = null
/** AI のつなぎ方のうち、この作りで使えるもの（vite.web.config.ts が埋めこむ。配る版は「自分の API キー」だけ） */
declare const __MANABI_WEB_ROUTES__: Route[]
setAllowedRoutes(__MANABI_WEB_ROUTES__)
/** 付属のサーバーを使う方式があるか（無ければ、サーバーの様子は聞かない） */
const usesServer = () => allowedRoutes().some((route) => route !== 'own-key')

/**
 * 教科書の検索（サーバーが無いとき）。ファイルを置くだけのサイトでは、科目ごとの本文のまとめ
 * （data/search/<科目>.json。tools/export-site.mjs が作る。授業の保存名 → 本文）を取り寄せて、ブラウザの中で探す。
 * まとめが 1 つも無ければ null（探せない）。
 */
const searchCorpus = new Map<string, Record<string, string> | null>()
async function searchStatic(q: SearchQuery): Promise<{ total: number; hits: RawLessonHit[] } | null> {
  const pattern = searchPattern(String(q?.query ?? '').slice(0, 60))
  if (!pattern) return { total: 0, hits: [] }
  const schools = Array.isArray(q.schools) && q.schools.length ? new Set(q.schools.map(String)) : null
  const courses = listCourses().filter((c) => (q.courseId ? c.id === q.courseId : !schools || schools.has(c.school)))
  let any = false
  const hits: RawLessonHit[] = []
  for (const course of courses) {
    if (!searchCorpus.has(course.id)) {
      const response = await fetch(`${base}data/search/${encodeURIComponent(course.id)}.json`).catch(() => null)
      searchCorpus.set(course.id, response?.ok ? ((await response.json().catch(() => null)) as Record<string, string> | null) : null)
    }
    const corpus = searchCorpus.get(course.id)
    if (!corpus) continue
    any = true
    for (const [key, body] of Object.entries(corpus)) {
      const { count, snippets } = findSnippets(body, pattern, 2)
      if (count) hits.push({ key, count, snippets })
    }
  }
  if (!any) return null
  hits.sort((a, b) => b.count - a.count)
  return { total: hits.length, hits: hits.slice(0, 400) }
}
async function refreshServerStatus(): Promise<void> {
  if (!usesServer()) return
  try {
    const response = await fetch(`${base}api/status`)
    serverStatus = response.ok ? ((await response.json()) as ServerStatus) : null
  } catch {
    serverStatus = null
  }
}
;(globalThis as { __manabiAiAvailable?: (name: string) => boolean }).__manabiAiAvailable = (name) => available(name, serverStatus)

// ───────── 学習時間（手前の画面が学習用で、操作が続いているあいだだけ数える） ─────────

let active: { view: ViewName; params: ViewParams } | null = null
export function noteActive(view: ViewName | null, params: ViewParams, idleSeconds: number): void {
  active = view ? { view, params } : null
  setIdleSeconds(idleSeconds)
}

// ───────── 画面からの要求 ─────────

function register(): void {
  // 画面を開く前の用意（テストの途中の制限、ノートの用意）。開くこと自体は、親のページが行う
  handle('web:prepare-open', async (_ctx, view: ViewName, params: ViewParams = {}) => {
    if (!VIEW_NAMES.includes(view)) throw new Error(t('不明な画面です。'))
    if (!allowedDuringTest(view, params)) return { view: 'test', params: {} }
    if (view === 'note' && !params.notebookId) {
      const meta = params.lessonId ? findLessonMeta(params.lessonId) : null
      const title = meta ? `${meta.lesson.number} ${meta.lesson.title}` : t('自由ノート')
      params = { ...params, notebookId: (await ensureNotebook(params.lessonId ?? null, title)).id }
    }
    return { view, params }
  })
  handle('web:start-view', () => (getActiveTest() ? 'test' : 'home'))

  handle('content:courses', () => listCourses())
  handle('content:curriculum', (_c, courseId: string) => getCurriculum(safeId(courseId || DEFAULT_COURSE_ID)))
  handle('content:ensure-curriculum', async (_c, courseId: string) => {
    await ensureCurriculum(safeId(courseId))
    broadcast('content')
    return getCurriculum(courseId)
  })
  handle('content:lesson', (_c, lessonId: string, variant?: LessonVariant) => getLesson(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard'))
  handle('content:generate', async (_c, lessonId: string, variant?: LessonVariant) => {
    const wanted: LessonVariant = variant === 'deep' ? 'deep' : 'standard'
    let lesson = await writeLesson(safeId(lessonId), wanted, getLibraryState().options.review)
    if (getLibraryState().options.talk) lesson = await addTalk(safeId(lessonId), wanted).catch(() => lesson)
    broadcast('content')
    return lesson
  })
  handle('content:translate', async (_c, lessonId: string, variant?: LessonVariant) => {
    const lesson = await translateLesson(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard')
    broadcast('content')
    return lesson
  })
  handle('content:talk', async (_c, lessonId: string, variant?: LessonVariant, redo?: boolean) => {
    const lesson = await addTalk(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard', !!redo)
    broadcast('content', 'library')
    return lesson
  })
  handle('content:sim', async (_c, lessonId: string, variant?: LessonVariant, redo?: boolean) => {
    const result = await addSim(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard', !!redo)
    broadcast('content', 'library')
    return result
  })
  // 授業ごとの注釈（用語・ふりがな・前提と関連）、用語集、年表、検索
  handle('annot:get', (_c, lessonId: string, variant?: LessonVariant) => getAnnotation(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard'))
  handle('annot:make', async (_c, lessonId: string, variant?: LessonVariant) => {
    if (getActiveTest()) throw new Error(t('テストの途中は、作れません。'))
    const annotation = await makeAnnotation(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard')
    broadcast('annot')
    return annotation
  })
  handle('annot:links', (_c, lessonId: string, variant?: LessonVariant) => getLessonLinks(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard'))
  handle('annot:glossary', (_c, query: GlossaryQuery) => listGlossary(query ?? {}))
  handle('annot:term', (_c, term: string) => getGlossaryTerm(String(term ?? '').slice(0, 60)))
  handle('annot:timeline', () => getTimeline())
  handle('annot:search', (_c, query: SearchQuery) => {
    if (getActiveTest()) throw new Error(t('テストの途中は、検索できません。'))
    // 教科書は、サーバーの側で探してもらう（ブラウザから 1 万件の授業を取り寄せて探すことは、できない）
    return runSearch(query, async (q) => {
      const response = await fetch(`${base}api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) }).catch(() => null)
      const found = response?.ok ? ((await response.json()) as { total: number; hits: RawLessonHit[] }) : await searchStatic(q)
      if (!found) throw new Error(t('教科書を探せませんでした（サーバーに届きません）。'))
      return { total: found.total, hits: lessonHits(found.hits, q, 60) }
    })
  })
  handle('media:picture', (_c, id: string) => getPicture(String(id).slice(0, 80)))
  handle('media:person', (_c, name: string) => getPerson(String(name).slice(0, 40)))
  handle('content:person-names', () => personNames())

  // 授業の動画（試作）は、この PC の読み上げソフトに頼るので、Web 版には無い
  handle('video:get', () => null)
  handle('video:voice', () => ({ ready: false, voice: '' }))
  for (const channel of ['video:make', 'video:audio', 'video:record', 'video:reveal']) handle(channel, () => {
    throw WEB_ONLY()
  })

  // 教材づくり（授業の一括作成）。Web 版では、裏でのまとめての作成は動かさない（1 件ずつの作成だけ）
  handle('library:get', () => getLibraryState())
  handle('library:set-enabled', (_c, enabled: boolean) => setLibraryEnabled(!!enabled))
  handle('library:set-options', (_c, patch: Partial<LibraryOptions>) => setLibraryOptions(patch ?? {}))
  handle('library:prioritize', (_c, courseId: string) => prioritizeCourse(safeId(courseId)))

  handle('characters:list', () => getCharacters())
  handle('characters:update', (_c, id: string, override: CharacterOverride) => {
    const settings = getSettings()
    const clean: CharacterOverride = {}
    for (const field of ['name', 'summary', 'persona', 'speech'] as const) {
      const value = override?.[field]
      if (typeof value === 'string' && value.trim()) clean[field] = value.trim().slice(0, 2000)
    }
    if (getLang() === 'ja') setSettings({ characterOverrides: { ...settings.characterOverrides, [safeId(id)]: clean } })
    else {
      const byLang = settings.characterOverridesByLang ?? {}
      setSettings({ characterOverridesByLang: { ...byLang, [getLang()]: { ...byLang[getLang()], [safeId(id)]: clean } } })
    }
    resetSessions()
    broadcast('characters')
    return getCharacters()
  })

  handle('settings:get', () => getSettings())
  handle('settings:set', async (_c, patch: Partial<Settings>) => {
    const allowed: Partial<Settings> = {}
    if (patch.ai) allowed.ai = patch.ai
    if (patch.characterId) allowed.characterId = patch.characterId
    if (patch.ruling) allowed.ruling = patch.ruling
    if (patch.keys && typeof patch.keys === 'object') {
      const known = new Set(KEY_ACTIONS.map((a) => a.id))
      allowed.keys = Object.fromEntries(Object.entries(patch.keys).filter(([id, value]) => known.has(id) && typeof value === 'string' && value.length <= 60))
    }
    if (patch.eikaiwa) allowed.eikaiwa = { tts: !!patch.eikaiwa.tts, unlimited: !!patch.eikaiwa.unlimited, showJa: !!patch.eikaiwa.showJa }
    if (typeof patch.furigana === 'boolean') allowed.furigana = patch.furigana
    if (patch.handedness === 'right' || patch.handedness === 'left') allowed.handedness = patch.handedness
    const language = isLang(patch.language) && patch.language !== getSettings().language ? patch.language : null
    if (language && getActiveTest()) throw new Error(t('テストの途中は、言語を切りかえられません。'))
    if (language) allowed.language = language
    const next = setSettings(allowed)
    if (patch.ai) resetSessions()
    broadcast('settings')
    // 文言は、開いた時点の言語で決まっているので、切りかえたらページを読みこみ直す
    if (language) {
      await flushFs()
      shell('reload')
    }
    return next
  })
  // 表示倍率（画面ごと）。実際に大きさを変えるのは、親のページ
  const zoomOf = (view: ViewName) => clampZoom(getSettings().zoom[view] ?? 1)
  const setZoom = (view: ViewName, factor: number) => {
    const value = clampZoom(factor)
    setSettings({ zoom: { ...getSettings().zoom, [view]: value } })
    shell('zoom', { view, value })
    broadcast('zoom', 'settings')
    return value
  }
  handle('zoom:get', (ctx) => zoomOf(ctx.view))
  handle('zoom:step', (ctx, direction: number) => setZoom(ctx.view, direction === 0 ? 1 : zoomOf(ctx.view) + (direction > 0 ? 0.1 : -0.1)))
  handle('zoom:set', (_c, view: ViewName, factor: number) => {
    if (!VIEW_NAMES.includes(view)) throw new Error(t('不明な画面です。'))
    return setZoom(view, factor)
  })

  handle('ai:status', async () => {
    await refreshServerStatus()
    return aiStatus()
  })

  // チャット（授業についての質問）と、ディベート中の先生への相談
  const relay = (ctx: Ctx, channel: string, characterId: string) => (messageId: string, full: string) =>
    post({ type: 'event', channel: 'chat:delta', to: ctx.key, payload: { lessonId: channel, characterId, messageId, text: full } })
  const cleanMessage = (text: string) => {
    const message = String(text ?? '').trim().slice(0, 4000)
    if (!message) throw new Error(t('メッセージを入力してください。'))
    return message
  }
  handle('chat:load', (_c, channel: string, characterId: string) => getChat(channel, characterId))
  handle('chat:send', async (ctx, lessonId: string, characterId: string, text: string) => {
    if (getActiveTest()) throw new Error(t('テストの途中は質問できません。'))
    const added = await sendChat(safeId(lessonId), safeId(characterId), cleanMessage(text), relay(ctx, lessonId, characterId))
    broadcast('chat')
    return added
  })
  handle('chat:clear', async (_c, channel: string, characterId: string) => {
    await clearChat(safeId(channel), safeId(characterId))
    broadcast('chat')
  })

  handle('debate:list', () => listDebates())
  handle('debate:get', (_c, id: string) => getDebate(id))
  handle('debate:topic', () => suggestTopic())
  handle('debate:start', (_c, setup: DebateSetup) => startDebate(setup))
  handle('debate:advance', async (_c, id: string, text: string | null) => {
    if (getActiveTest()) throw new Error(t('テストの途中はディベートできません。'))
    const session = await advanceDebate(safeId(id), typeof text === 'string' ? text : null, () => broadcast('debate'))
    broadcast('debate', 'skills')
    return session
  })
  handle('debate:coach', async (ctx, id: string, text: string) => {
    const session = getDebate(safeId(id))
    if (!session) throw new Error(t('ディベートが見つかりません。'))
    return sendCoach(debateBrief(session), cleanMessage(text), relay(ctx, COACH_CHANNEL, coach().id))
  })
  handle('skills:get', () => getSkills())

  handle('eikaiwa:level', () => eikaiwaLevel())
  handle('eikaiwa:translate', (_c, text: string) => {
    if (getActiveTest()) throw new Error(t('テストの途中は英会話できません。'))
    return toEnglish(cleanMessage(text).slice(0, 400))
  })
  handle('eikaiwa:say', async (ctx, characterId: string, text: string) => {
    if (getActiveTest()) throw new Error(t('テストの途中は英会話できません。'))
    const added = await sayInEikaiwa(safeId(characterId), cleanMessage(text).slice(0, 400), relay(ctx, EIKAIWA_CHANNEL, characterId))
    broadcast('chat', 'skills')
    return added
  })

  // 音声の文字起こし（Electron 版は、この PC の中の whisper.cpp）。Web 版には、まだ無い
  const noSpeech: SpeechStatus = { ready: false, engine: false, installed: [], model: getSettings().speechModel, progress: null, error: t('音声の文字起こしは、Web 版ではまだ使えません。') }
  handle('speech:status', () => noSpeech)
  handle('speech:install', () => {
    throw WEB_ONLY()
  })
  handle('speech:choose', () => noSpeech)
  handle('speech:transcribe', () => {
    throw WEB_ONLY()
  })
  // 英語の読み上げは、ブラウザの音声を使う（この PC の音声を使う予備の道は無い）
  handle('tts:status', () => false)
  handle('tts:speak', () => undefined)
  handle('tts:stop', () => undefined)

  // 漢字特訓
  const kanjiChanged = () => broadcast('kanji')
  handle('kanji:state', () => kanjiState())
  handle('kanji:count', (_c, setup: KanjiSetup) => kanjiCount(setup))
  handle('kanji:start', (_c, setup: KanjiSetup) => {
    if (getActiveTest()) throw new Error(t('テストの途中は特訓できません。'))
    const state = startKanji(setup, kanjiChanged)
    kanjiChanged()
    shell('open', { view: 'kanjiOrder', params: {} })
    shell('open', { view: 'kanjiNote', params: {} })
    return state
  })
  handle('kanji:written', (_c, count: number) => {
    reportKanjiWritten(count)
    kanjiChanged()
  })
  handle('kanji:clear', () => {
    const state = clearKanji(kanjiChanged)
    broadcast('kanji', 'skills')
    return state
  })
  handle('kanji:skip', () => {
    const state = skipKanji(kanjiChanged)
    kanjiChanged()
    return state
  })
  handle('kanji:retry-words', () => retryKanjiWords(kanjiChanged))
  handle('kanji:stop', () => {
    const state = stopKanji()
    shell('close', { views: ['kanjiOrder', 'kanjiNote'] })
    kanjiChanged()
    return state
  })

  // 語彙力特訓
  const vocabChanged = () => broadcast('vocab')
  handle('vocab:state', () => vocabState())
  handle('vocab:mode', (_c, mode: 'own' | 'copy') => {
    const state = setVocabMode(mode)
    vocabChanged()
    return state
  })
  handle('vocab:start', async (_c, lang: VocabLang, levelId: string) => {
    if (getActiveTest()) throw new Error(t('テストの途中は特訓できません。'))
    const state = await startVocab(lang === 'en' ? 'en' : 'ja', String(levelId), vocabChanged)
    if (state.notebookId) shell('open', { view: 'note', params: { notebookId: state.notebookId } })
    return state
  })
  handle('vocab:check', async (_c, images: string[]) => {
    const state = await checkVocab(images, vocabChanged)
    broadcast('skills')
    return state
  })
  handle('vocab:skip', () => skipVocab(vocabChanged))
  handle('vocab:stop', () => {
    const state = stopVocab()
    vocabChanged()
    return state
  })

  handle('notes:list', () => listNotebooks())
  handle('notes:get', (_c, id: string) => {
    if (!allowedDuringTest('note', { notebookId: id })) throw new Error(t('テストが終わるまで、ほかのノートは開けません。'))
    return getNotebook(id)
  })
  handle('notes:save', async (_c, notebook: Notebook) => {
    safeId(notebook?.id)
    if (!Array.isArray(notebook.pages)) throw new Error(t('ノートの形式が正しくありません。'))
    await saveNotebook(notebook)
    broadcast('notes')
  })
  handle('notes:evaluations', (_c, notebookId: string) => getEvaluations(notebookId))
  handle('notes:evaluate', async (_c, request: EvaluateRequest) => {
    const result = await evaluateNote(request)
    broadcast('evaluations', 'report')
    return result
  })
  // メモ（授業と関係なく使うノート）
  handle('notes:create-memo', async (_c, title: string) => {
    if (getActiveTest()) throw new Error(t('テストの途中は、メモを作れません。'))
    const name = String(title ?? '').trim().slice(0, 60) || t('無題のメモ')
    const notebook = await createNotebook(name, null, 'memo')
    broadcast('notes')
    return listNotebooks().find((n) => n.id === notebook.id)
  })
  handle('notes:delete-memo', (_c, id: string) => {
    shell('close-key', { key: `note:${safeId(id)}` })
    deleteMemo(safeId(id))
    broadcast('notes')
  })
  // 手書きの文字起こし（評価はしない）
  handle('notes:transcribe', (_c, request: EvaluateRequest) => {
    if (getActiveTest()) throw new Error(t('テストの途中は、文字起こしできません。'))
    return transcribeNote(request)
  })
  handle('notes:save-transcripts', async (_c, id: string, results: { pageId: string; stamp: string; text: string }[]) => {
    const written = await saveTranscripts(safeId(id), Array.isArray(results) ? results : [])
    if (written) broadcast('notes', `transcript:${id}`)
    return written
  })
  // PDF は、ここで作って、親のページが「ダウンロード」として渡す
  handle('web:pdf', (_c, title: string, images: string[]) => buildPdf(String(title), images))

  // ノートに貼る画像（選ぶのは親のページ。ここでは、受けとって、この端末に残す）
  handle('web:attachment-import', (_c, file: { name: string; bytes: ArrayBuffer; width: number; height: number }) => {
    const extension = (/\.(png|jpe?g|gif|webp)$/i.exec(file.name)?.[1] ?? '').toLowerCase().replace('jpeg', 'jpg')
    if (!extension) throw new Error(t('この種類の画像は貼れません（PNG・JPEG・GIF・WebP に対応しています）。'))
    if (file.bytes.byteLength > 20 * 1024 * 1024) throw new Error(t('画像が大きすぎます（20MB まで）。'))
    if (!file.width || !file.height) throw new Error(t('画像を読みこめませんでした。'))
    const attachmentId = `${randomUUID()}.${extension}`
    writeFileSync(join(dataDir('attachments'), attachmentId), new Uint8Array(file.bytes))
    return { attachmentId, name: file.name, width: file.width, height: file.height }
  })
  handle('attachments:data', (_c, attachmentId: string) => attachmentDataUrl(String(attachmentId)))
  handle('attachments:pick-video', () => {
    throw WEB_ONLY()
  })

  // テスト
  handle('test:active', () => getActiveTest())
  handle('test:start', async (_c, setup: TestSetup) => {
    const session = await startTest(setup)
    shell('close-except', { keep: 'test' })
    broadcast('test')
    return session
  })
  handle('test:submit', async (_c, answers: Record<string, string>) => {
    const result = await submitTest(answers ?? {})
    broadcast('test', 'report')
    return result
  })
  handle('test:abort', () => {
    abortTest()
    shell('close-except', { keep: 'test' })
    broadcast('test')
  })
  handle('test:results', () => listTestResults())
  handle('test:result', (_c, id: string) => getTestResult(id))

  // 記述・論述の練習
  handle('essay:get', (_c, lessonId: string, variant?: LessonVariant) => getEssaySet(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard'))
  handle('essay:make', async (_c, lessonId: string, variant?: LessonVariant) => {
    if (getActiveTest()) throw new Error(t('テストの途中は、作れません。'))
    const set = await makeEssaySet(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard')
    broadcast('essay')
    return set
  })
  handle('essay:review', async (_c, request: EssayReviewRequest) => {
    if (getActiveTest()) throw new Error(t('テストの途中は、練習できません。'))
    const attempt = await reviewEssay(request ?? { kind: 'short', question: '' })
    broadcast('essay')
    return attempt
  })
  handle('essay:attempts', (_c, lessonId?: string) => listEssayAttempts(lessonId ? safeId(lessonId) : undefined))

  // 週ごとの評価
  handle('report:subjects', () => activeSubjects())
  handle('report:list', (_c, subjectId: string) => listReports(safeId(subjectId)))
  handle('report:comment', async (_c, weekStart: string, subjectId: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekStart))) throw new Error(t('週の指定が正しくありません。'))
    const report = await commentOnWeek(weekStart, safeId(subjectId))
    broadcast('report')
    return report
  })

  // ───────── Web 版だけの要求（AI のつなぎ方、この端末のデータ） ─────────
  const publicConfig = (config: WebAiConfig) => ({ ...config, anthropicKey: config.anthropicKey ? '設定ずみ' : '', openaiKey: config.openaiKey ? '設定ずみ' : '' })
  handle('web:ai-config', async () => {
    await refreshServerStatus()
    return { config: publicConfig(getAiConfig()), server: serverStatus, routes: allowedRoutes() }
  })
  // Windows 版の設定画面にある「AI のつなぎ方」は、Web 版では、上の帯のボタンから開く（ここでは、何も返さない）
  handle('ai:link:get', () => null)
  handle('web:ai-config-set', async (_c, patch: Partial<WebAiConfig>) => {
    const next = setAiConfig(patch ?? {})
    resetSessions()
    await refreshServerStatus()
    broadcast('settings')
    return { config: publicConfig(next), server: serverStatus, routes: allowedRoutes() }
  })
  handle('web:ai-usage', () => getUsageRows())
  handle('web:storage', () => localUsage())
  handle('web:clear-data', async () => {
    await flushWrites()
    await clearFs()
    shell('reload')
  })
  handle('web:flush', async () => {
    await flushWrites()
    await flushFs()
  })
}

/** はじめに 1 回。返すのは、表示する言語 */
export async function start(options: { base: string }): Promise<string> {
  base = options.base
  migrateCharacters()
  register()
  void refreshServerStatus()
  startUsageTracking(() => {
    if (!active || !STUDY_VIEWS.includes(active.view)) return null
    if (active.view === 'test') return getActiveTest()?.subjectId ?? null
    const lessonId = active.view === 'note' ? getNotebook(active.params.notebookId ?? '')?.lessonId : active.params.lessonId
    return subjectOfLesson(lessonId ?? null)
  })
  const settle = () => settleWeeks() && broadcast('report')
  settle()
  setInterval(settle, 60 * 60 * 1000)
  return getLang()
}

export async function invoke(ctx: Ctx, channel: string, args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Web 版には、まだ無い要求です: ${channel}`)
  // どの仕事のための AI の呼び出しかを覚えておく（モデルの割り当てと、使用量の記録に使う）
  setTask(channel)
  return handler(ctx, ...args)
}
