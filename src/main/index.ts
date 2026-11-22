// 表示する言語は、ほかのモジュールが文言を決める前に設定する
import './lang'
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell, type IpcMainInvokeEvent, type Rectangle } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  COACH_CHANNEL,
  EIKAIWA_CHANNEL,
  type CharacterOverride,
  type DebateSetup,
  type EssayReviewRequest,
  type EvaluateRequest,
  type GlossaryQuery,
  type AiLinkPatch,
  type AiLinkState,
  type KanjiSetup,
  type LessonVariant,
  type LibraryOptions,
  type Notebook,
  type SearchQuery,
  type Settings,
  type SpeechModelId,
  type TestSetup,
  type ViewName,
  type ViewParams,
  type VocabLang,
} from '@shared/types'
import { getLang, isLang, t } from '@shared/i18n'
import { KEY_ACTIONS, clampZoom } from '@shared/keys'
import { aiStatus, clearChat, closeAllSessions, evaluateNote, coach, resetSessions, sendChat, sendCoach, transcribeNote } from './ai'
import { linkState, linkStatus, noteTask, setLink, signIn, signOut, siwcModels } from './ai/link'
import { isDevEdition } from './edition'
import { importPack } from './pack'
import { getAnnotation, getGlossaryTerm, getLessonLinks, getTimeline, listGlossary, makeAnnotation, runSearch } from './annot'
import { attachmentDataUrl, openTarget, pickImage, pickVideo } from './attachments'
import { DEFAULT_COURSE_ID, findLessonMeta, getCharacters, getCurriculum, getLesson, listCourses, personNames, subjectOfLesson } from './content'
import { eikaiwaLevel, sayInEikaiwa, toEnglish } from './eikaiwa'
import { getEssaySet, listEssayAttempts, makeEssaySet, reviewEssay } from './essay'
import { advanceDebate, debateBrief, getDebate, listDebates, startDebate, suggestTopic } from './debate'
import { clearKanji, kanjiCount, kanjiState, reportKanjiWritten, retryKanjiWords, skipKanji, startKanji, stopKanji } from './kanji'
import { addSim, addTalk, ensureCurriculum, getLibraryState, prioritizeCourse, setLibraryEnabled, setLibraryOptions, startLibrary, writeLesson } from './library'
import { getPerson, getPicture } from './media'
import { getVideo, makeVideo, recordVideo, videoAudio, voiceStatus } from './video'
import { safeId } from './paths'
import { translateLesson } from './translate'
import { getSkills } from './skills'
import { chooseSpeechModel, installSpeech, onSpeechChanged, speechStatus, stopSpeechServer, transcribe } from './speech'
import { buildPdf, exportPdf } from './pdf'
import { activeSubjects, commentOnWeek, listReports, settleWeeks } from './report'
import {
  JsonState,
  createNotebook,
  dataFile,
  deleteMemo,
  ensureNotebook,
  flushWrites,
  getChat,
  getEvaluations,
  getNotebook,
  getSettings,
  listNotebooks,
  migrateCharacters,
  saveNotebook,
  saveTranscripts,
  setSettings,
} from './store'
import { closeTts, systemSpeak, systemStop, systemVoiceReady } from './tts'
import { abortTest, getActiveTest, getTestResult, listTestResults, startTest, submitTest } from './test'
import { startUsageTracking } from './usage'
import { checkVocab, setVocabMode, skipVocab, startVocab, stopVocab, vocabState } from './vocab'

// ───────── ウィンドウ ─────────

const VIEWS: Record<ViewName, { title: string; width: number; height: number; minWidth: number; minHeight: number }> = {
  home: { title: t('学びアイ'), width: 1180, height: 820, minWidth: 560, minHeight: 520 },
  textbook: { title: t('教科書 — 学びアイ'), width: 1040, height: 900, minWidth: 560, minHeight: 520 },
  chat: { title: t('チャット — 学びアイ'), width: 980, height: 820, minWidth: 560, minHeight: 520 },
  note: { title: t('ノート — 学びアイ'), width: 1500, height: 960, minWidth: 560, minHeight: 520 },
  memo: { title: t('メモ — 学びアイ'), width: 1000, height: 820, minWidth: 560, minHeight: 480 },
  glossary: { title: t('用語集 — 学びアイ'), width: 1180, height: 860, minWidth: 560, minHeight: 480 },
  search: { title: t('検索 — 学びアイ'), width: 980, height: 860, minWidth: 560, minHeight: 480 },
  timeline: { title: t('年表 — 学びアイ'), width: 1180, height: 880, minWidth: 560, minHeight: 480 },
  essay: { title: t('記述・論述の練習 — 学びアイ'), width: 1100, height: 900, minWidth: 560, minHeight: 520 },
  test: { title: t('テスト — 学びアイ'), width: 1040, height: 880, minWidth: 760, minHeight: 600 },
  debate: { title: t('ディベート — 学びアイ'), width: 1240, height: 880, minWidth: 900, minHeight: 600 },
  eikaiwa: { title: t('英会話 — 学びアイ'), width: 1040, height: 860, minWidth: 760, minHeight: 600 },
  vocab: { title: t('語彙力特訓 — 学びアイ'), width: 980, height: 860, minWidth: 720, minHeight: 560 },
  kanji: { title: t('漢字特訓 — 学びアイ'), width: 640, height: 640, minWidth: 460, minHeight: 420 },
  kanjiOrder: { title: t('書き順 — 漢字特訓'), width: 520, height: 580, minWidth: 320, minHeight: 360 },
  kanjiNote: { title: t('ノート — 漢字特訓'), width: 1280, height: 900, minWidth: 760, minHeight: 520 },
  report: { title: t('成績 — 学びアイ'), width: 1100, height: 880, minWidth: 820, minHeight: 600 },
  library: { title: t('教材づくり — 学びアイ'), width: 1100, height: 880, minWidth: 820, minHeight: 600 },
  settings: { title: t('設定 — 学びアイ'), width: 900, height: 880, minWidth: 620, minHeight: 480 },
  video: { title: t('動画（試作） — 学びアイ'), width: 1296, height: 820, minWidth: 720, minHeight: 480 },
}

/** 学習時間として数えるモード */
const STUDY_VIEWS: ViewName[] = ['textbook', 'chat', 'note', 'test']

interface OpenView {
  window: BrowserWindow
  view: ViewName
  params: ViewParams
}

/**
 * ノート以外はモードごとに 1 枚（別の授業を開くと、そのウィンドウの中身が切り替わる）。
 * ノートは 1 冊ごとに 1 枚。同じものを開こうとしたら手前に出す。
 */
const openViews = new Map<string, OpenView>()

function viewKey(view: ViewName, params: ViewParams): string {
  return view === 'note' ? `note:${params.notebookId ?? ''}` : view
}

/**
 * ウィンドウの位置と大きさを、モードごとに覚えておく。
 * （特訓のようにウィンドウを並べて使うモードで、開くたびに並べ直さなくて済むように）
 */
const windowBounds = new JsonState<Record<string, Rectangle & { maximized?: boolean }>>(() => dataFile('windows.json'), () => ({}))

// ───────── 表示倍率 ─────────

const zoomOf = (view: ViewName) => clampZoom(getSettings().zoom[view] ?? 1)

/** その画面（モード）の表示倍率を変える。開いているウィンドウにすぐ反映し、設定にも覚える */
function setZoom(view: ViewName, factor: number): number {
  const value = clampZoom(factor)
  setSettings({ zoom: { ...getSettings().zoom, [view]: value } })
  for (const open of openViews.values()) {
    if (open.view === view && !open.window.isDestroyed()) open.window.webContents.setZoomFactor(value)
  }
  broadcast('zoom', 'settings')
  return value
}

/**
 * 漢字特訓の 3 つのウィンドウは、はじめから重ならないように並べる
 * （左上に漢字、その下に書き順、右に大きくノート）。動かしたあとは、その位置を覚える。
 */
function defaultBounds(view: ViewName): Partial<Rectangle> {
  if (view !== 'kanji' && view !== 'kanjiOrder' && view !== 'kanjiNote') return {}
  const area = screen.getPrimaryDisplay().workArea
  const left = Math.min(620, Math.round(area.width * 0.34))
  const top = Math.round(area.height * 0.56)
  if (view === 'kanji') return { x: area.x, y: area.y, width: left, height: top }
  if (view === 'kanjiOrder') return { x: area.x, y: area.y + top, width: left, height: area.height - top }
  return { x: area.x + left, y: area.y, width: area.width - left, height: area.height }
}

function rememberedBounds(view: ViewName): Partial<Rectangle> & { maximized?: boolean } {
  const saved = windowBounds.get()[view]
  if (!saved || !(saved.width > 200 && saved.height > 200)) return defaultBounds(view)
  // つないでいた画面を外したときなど、見えない場所になる場合は使わない
  const visible = screen
    .getAllDisplays()
    .some(({ workArea: a }) => saved.x + saved.width > a.x + 100 && saved.x < a.x + a.width - 100 && saved.y >= a.y - 20 && saved.y < a.y + a.height - 100)
  if (!visible) return {}
  // 同じモードのウィンドウ（別のノート）がすでに同じ場所にあれば、少しずらす
  const taken = [...openViews.values()].some((v) => v.view === view && !v.window.isDestroyed() && v.window.getBounds().x === saved.x && v.window.getBounds().y === saved.y)
  return taken ? { ...saved, x: saved.x + 32, y: saved.y + 32, maximized: false } : saved
}

function focus(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore()
  window.focus()
}

// ───────── ウィンドウの固定 ─────────

type Side = 'left' | 'right'
/**
 * 固定しているウィンドウ（1 つまで）。固定したウィンドウは、画面の左半分または右半分に置く。
 * 固定中に、ほかの画面を開くと、そのウィンドウを反対側の半分に置く（固定したウィンドウに重ならない）。
 */
let pinned: { key: string; side: Side } | null = null
const KANJI_VIEWS: ViewName[] = ['kanji', 'kanjiOrder', 'kanjiNote']

/** 固定しているウィンドウ（閉じられていたら、固定を解く） */
function pinnedWindow(): BrowserWindow | null {
  const found = pinned && openViews.get(pinned.key)
  if (found && !found.window.isDestroyed()) return found.window
  pinned = null
  return null
}

/** そのウィンドウがある画面の、左半分または右半分 */
function halfOf(window: BrowserWindow, side: Side): Rectangle {
  const area = screen.getDisplayMatching(window.getBounds()).workArea
  const half = Math.round(area.width / 2)
  return side === 'left' ? { x: area.x, y: area.y, width: half, height: area.height } : { x: area.x + half, y: area.y, width: area.width - half, height: area.height }
}

function moveTo(window: BrowserWindow, bounds: Rectangle): void {
  if (window.isMaximized()) window.unmaximize()
  if (window.isFullScreen()) window.setFullScreen(false)
  window.setBounds(bounds)
}

/** 固定中に開いた（手前に出した）画面を、固定したウィンドウの反対側に置く */
function placeBesidePinned(key: string, view: ViewName, window: BrowserWindow): void {
  const anchor = pinnedWindow()
  if (!anchor || !pinned || key === pinned.key || KANJI_VIEWS.includes(view)) return
  moveTo(window, halfOf(anchor, pinned.side === 'left' ? 'right' : 'left'))
}

/** 教科書といっしょに開いているノート（1 冊だけ） */
let companion: string | null = null

/** 教科書といっしょに開くノート: 利き手の側に固定して、教科書は反対側に並べる */
function pinBeside(key: string, params: ViewParams): void {
  if (params.beside !== 'left' && params.beside !== 'right') return
  // 授業を移ったら、前の授業のノートは閉じる（ノートのウィンドウが、開いた授業の数だけ増えていかないように）。
  // 書きこみは、ノートのウィンドウから教科書へ移ったとき（フォーカスが外れたとき）に保存してある
  const before = companion && companion !== key ? openViews.get(companion) : undefined
  companion = key
  if (before && !before.window.isDestroyed()) before.window.close()
  if (setPinned(key, params.beside) !== params.beside) return
  const textbook = openViews.get(viewKey('textbook', {}))
  if (textbook && !textbook.window.isDestroyed()) placeBesidePinned(viewKey('textbook', {}), 'textbook', textbook.window)
}

function setPinned(key: string, side: Side | null): Side | null {
  const target = openViews.get(key)
  if (!side || !target || target.window.isDestroyed()) {
    // 「固定をやめる」は、どの画面から頼まれても、いまの固定を解く
    if (!side) pinned = null
    broadcast('pin')
    return null
  }
  pinned = { key, side }
  moveTo(target.window, halfOf(target.window, side))
  broadcast('pin')
  return side
}

/**
 * テストを受けている間に開けるのは、テストの画面と、そのテスト専用のノートだけ。
 * 教科書・ディベート・過去のノートなどは、テストが終わるまで開けない。
 */
function allowedDuringTest(view: ViewName, params: ViewParams): boolean {
  const active = getActiveTest()
  if (!active) return true
  return view === 'test' || view === 'settings' || (view === 'note' && params.notebookId === active.notebookId)
}

function closeAllExcept(keep: ViewName): void {
  for (const { window, view } of [...openViews.values()]) {
    if (view !== keep && !window.isDestroyed()) window.destroy()
  }
}

async function openView(view: ViewName, params: ViewParams = {}): Promise<void> {
  if (!allowedDuringTest(view, params)) {
    const test = openViews.get('test')
    if (test && !test.window.isDestroyed()) focus(test.window)
    else await openView('test')
    return
  }

  // 教材づくりは、開発用の版だけ
  if (view === 'library' && !isDevEdition()) return

  // ノートは授業に 1 冊。開く前に、対応するノートを用意しておく
  if (view === 'note' && !params.notebookId) {
    const meta = params.lessonId ? findLessonMeta(params.lessonId) : null
    const title = meta ? `${meta.lesson.number} ${meta.lesson.title}` : t('自由ノート')
    params = { ...params, notebookId: (await ensureNotebook(params.lessonId ?? null, title)).id }
  }

  const key = viewKey(view, params)
  const existing = openViews.get(key)
  if (existing && !existing.window.isDestroyed()) {
    existing.params = params
    existing.window.webContents.send('view:params', params)
    placeBesidePinned(key, view, existing.window)
    pinBeside(key, params)
    // 教科書といっしょに開くノートは、手前に出さない（操作しているのは教科書なので）
    if (!params.beside) focus(existing.window)
    else if (existing.window.isMinimized()) existing.window.restore()
    return
  }

  const spec = VIEWS[view]
  const remembered = rememberedBounds(view)
  const window = new BrowserWindow({
    title: spec.title,
    x: remembered.x,
    y: remembered.y,
    width: remembered.width ?? spec.width,
    height: remembered.height ?? spec.height,
    minWidth: spec.minWidth,
    minHeight: spec.minHeight,
    show: false,
    backgroundColor: '#f7f3ea',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      // 表示倍率は「同じ置き場のページすべて」に効く仕組みなので、画面（モード）ごとに置き場を分けて、別々に変えられるようにする
      partition: `view-${view}`,
      zoomFactor: zoomOf(view),
      // 動画は、ウィンドウがほかのものに隠れていても、再生と録画を止めない
      backgroundThrottling: view !== 'video',
    },
  })
  openViews.set(key, { window, view, params })
  // 固定しているウィンドウがあれば、新しい画面は、その反対側に置く
  placeBesidePinned(key, view, window)
  pinBeside(key, params)
  // 動画の画面は、自分の画面と音をそのまま録画して、動画ファイルに書き出す（ほかの画面や、PC のほかの音は録らない）
  if (view === 'video') {
    window.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      const own = request.frame && request.frame === window.webContents.mainFrame
      try {
        callback(own ? { video: request.frame!, audio: request.frame! } : {})
      } catch {
        // 許さない要求は、そのまま失敗させる
      }
    })
  }
  window.on('closed', () => {
    openViews.delete(key)
    if (pinned?.key === key) {
      pinned = null
      broadcast('pin')
    }
  })
  window.on('close', () => {
    // 固定で半分に置いているあいだの位置は、覚えない（固定をやめたあとに開くときは、もとの位置と大きさにもどる）
    if (!window.isMinimized() && !pinnedWindow()) windowBounds.update((all) => ({ ...all, [view]: { ...window.getNormalBounds(), maximized: window.isMaximized() } }))
  })
  window.once('ready-to-show', () => {
    if (remembered.maximized && !(pinnedWindow() && !KANJI_VIEWS.includes(view))) window.maximize()
    // 教科書といっしょに開くノートは、見せるだけで、手前（キーの入力先）にはしない
    if (params.beside) window.showInactive()
    else window.show()
  })
  window.webContents.on('did-finish-load', () => window.webContents.setZoomFactor(zoomOf(view)))
  // Ctrl を押しながらホイールを回すと、表示倍率を 10% ずつ変える
  window.webContents.on('zoom-changed', (_event, direction) => setZoom(view, zoomOf(view) + (direction === 'in' ? 0.1 : -0.1)))

  if (view === 'test') {
    // テストの途中で閉じようとしたら、やめるかどうかを確かめる
    window.on('close', (event) => {
      if (!getActiveTest()) return
      const choice = dialog.showMessageBoxSync(window, {
        type: 'question',
        title: t('テスト'),
        message: t('テストの途中です。やめますか？'),
        detail: t('やめると、このテストは採点されず、記録にも残りません。'),
        buttons: [t('テストを続ける'), t('テストをやめる')],
        defaultId: 0,
        cancelId: 0,
      })
      if (choice === 0) return event.preventDefault()
      abortTest()
      closeAllExcept('test')
      void openView('home')
    })
  }

  // 画面の外へ移動させない。リンクは https のものだけ既定のブラウザで開く。
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
  window.on('page-title-updated', (event) => event.preventDefault())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) await window.loadURL(`${devUrl}?view=${view}`)
  else await window.loadFile(join(__dirname, '../renderer/index.html'), { query: { view } })
}

function viewOf(event: IpcMainInvokeEvent): OpenView | undefined {
  return [...openViews.values()].find((v) => v.window.webContents === event.sender)
}

/** ほかのウィンドウにも変更を知らせる（例: ノートの評価が増えた、設定が変わった） */
function broadcast(...topics: string[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    for (const topic of topics) window.webContents.send('changed', topic)
  }
}

// ───────── 画面からの要求 ─────────

function handle<Args extends unknown[], Result>(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    // どの仕事のための AI の呼び出しかを覚えておく（API で動かすときの、モデルの割り当てと使った量の記録に使う）
    noteTask(channel)
    return fn(event, ...(args as Args))
  })
}

function registerHandlers(): void {
  // 画面が、文言を決める前に言語を知るための問い合わせ（待たずに答える）
  ipcMain.on('i18n:lang', (event) => {
    event.returnValue = getLang()
  })
  // 教材づくりと、掛け合い・動く図解の作り直しを出すか（開発用の版だけ。配る版では出さない）
  ipcMain.on('app:authoring', (event) => {
    event.returnValue = isDevEdition()
  })

  handle('view:get', (event) => {
    const found = viewOf(event)
    return { view: found?.view ?? 'home', params: found?.params ?? {} }
  })
  handle('view:open', (_e, view: ViewName, params: ViewParams) => {
    if (!(view in VIEWS)) throw new Error(t('不明な画面です。'))
    return openView(view, params ?? {})
  })

  // ウィンドウの固定（左・右・やめる）
  handle('view:pin', (event, side: Side | null) => {
    const found = viewOf(event)
    if (!found) return null
    return setPinned(viewKey(found.view, found.params), side === 'left' || side === 'right' ? side : null)
  })
  handle('view:pinned', (event) => {
    const found = viewOf(event)
    return found && pinnedWindow() && pinned?.key === viewKey(found.view, found.params) ? pinned.side : null
  })

  handle('view:context', (event, patch: ViewParams) => {
    // いま開いている授業を覚えておく（学習時間を、どの教科のものとして数えるかに使う）
    const found = viewOf(event)
    if (found) found.params = { ...found.params, ...patch }
  })

  handle('content:courses', () => listCourses())
  handle('content:curriculum', (_e, courseId: string) => getCurriculum(safeId(courseId || DEFAULT_COURSE_ID)))
  handle('content:ensure-curriculum', async (_e, courseId: string) => {
    await ensureCurriculum(safeId(courseId))
    broadcast('content')
    return getCurriculum(courseId)
  })
  handle('content:lesson', (_e, lessonId: string, variant?: LessonVariant) => getLesson(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard'))
  handle('content:generate', async (_e, lessonId: string, variant?: LessonVariant) => {
    const wanted: LessonVariant = variant === 'deep' ? 'deep' : 'standard'
    let lesson = await writeLesson(safeId(lessonId), wanted, getLibraryState().options.review)
    // 「掛け合いを足す」が有効なら、その場で作った授業にも足す（足せなくても、本文はそのまま読める）
    if (getLibraryState().options.talk) lesson = await addTalk(safeId(lessonId), wanted).catch(() => lesson)
    broadcast('content')
    return lesson
  })
  // 訳がまだ無い授業を、いまの表示の言語に訳す
  handle('content:translate', async (_e, lessonId: string, variant?: LessonVariant) => {
    const lesson = await translateLesson(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard')
    broadcast('content')
    return lesson
  })
  // できあがっている授業に、掛け合いを足す（redo が真なら作り直す）
  handle('content:talk', async (_e, lessonId: string, variant?: LessonVariant, redo?: boolean) => {
    const lesson = await addTalk(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard', !!redo)
    broadcast('content', 'library')
    return lesson
  })

  // できあがっている授業に、合う「動く図解」があれば足す（redo が真なら選び直す）
  handle('content:sim', async (_e, lessonId: string, variant?: LessonVariant, redo?: boolean) => {
    const result = await addSim(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard', !!redo)
    broadcast('content', 'library')
    return result
  })
  // 授業ごとの注釈（用語・ふりがな・前提と関連）、用語集、年表、検索
  handle('annot:get', (_e, lessonId: string, variant?: LessonVariant) => getAnnotation(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard'))
  handle('annot:make', async (_e, lessonId: string, variant?: LessonVariant) => {
    if (getActiveTest()) throw new Error(t('テストの途中は、作れません。'))
    const annotation = await makeAnnotation(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard')
    broadcast('annot')
    return annotation
  })
  handle('annot:links', (_e, lessonId: string, variant?: LessonVariant) => getLessonLinks(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard'))
  handle('annot:glossary', (_e, query: GlossaryQuery) => listGlossary(query ?? {}))
  handle('annot:term', (_e, term: string) => getGlossaryTerm(String(term ?? '').slice(0, 60)))
  handle('annot:timeline', () => getTimeline())
  handle('annot:search', (_e, query: SearchQuery) => {
    if (getActiveTest()) throw new Error(t('テストの途中は、検索できません。'))
    return runSearch(query)
  })
  // 挿絵と、歴史上の人物の絵
  handle('media:picture', (_e, id: string) => getPicture(String(id).slice(0, 80)))
  handle('media:person', (_e, name: string) => getPerson(String(name).slice(0, 40)))
  // 掛け合いに出てくる歴史上の人物の、名前の訳（日本語のときは空）
  handle('content:person-names', () => personNames())
  // 授業の動画（試作）
  const variantOf = (variant?: LessonVariant): LessonVariant => (variant === 'deep' ? 'deep' : 'standard')
  handle('video:get', (_e, lessonId: string, variant?: LessonVariant) => getVideo(safeId(lessonId), variantOf(variant)))
  handle('video:voice', () => voiceStatus())
  handle('video:make', async (event, lessonId: string, variant?: LessonVariant, redo?: boolean) => {
    const info = await makeVideo(safeId(lessonId), variantOf(variant), !!redo, (progress) => !event.sender.isDestroyed() && event.sender.send('video:progress', progress))
    broadcast('video')
    return info
  })
  handle('video:audio', (_e, lessonId: string, variant: LessonVariant | undefined, index: number) => videoAudio(safeId(lessonId), variantOf(variant), Number(index) || 0))
  // 録画のあいだは、ウィンドウの中身を 1280 × 720（動画の大きさ）にし、終わったら元の大きさにもどす
  const beforeRecording = new Map<number, Rectangle>()
  handle('video:record', async (event, lessonId: string, variant: LessonVariant | undefined, action: 'start' | 'chunk' | 'end' | 'cancel', chunk?: ArrayBuffer) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (action === 'start' && window) {
      if (window.isMaximized()) window.unmaximize()
      beforeRecording.set(window.id, window.getBounds())
      const zoom = event.sender.getZoomFactor()
      window.setContentSize(Math.round(1280 * zoom), Math.round(720 * zoom))
    }
    if ((action === 'end' || action === 'cancel') && window && !window.isDestroyed()) {
      const bounds = beforeRecording.get(window.id)
      if (bounds) window.setBounds(bounds)
      beforeRecording.delete(window.id)
    }
    const file = await recordVideo(safeId(lessonId), variantOf(variant), action === 'start' || action === 'end' || action === 'cancel' ? action : 'chunk', chunk)
    if (action === 'end') broadcast('video')
    return file
  })
  handle('video:reveal', (_e, lessonId: string, variant?: LessonVariant) => {
    const file = getVideo(safeId(lessonId), variantOf(variant))?.file
    if (file) shell.showItemInFolder(file)
  })

  // 教材づくり（授業の一括作成）
  handle('library:get', () => getLibraryState())
  handle('library:set-enabled', (_e, enabled: boolean) => setLibraryEnabled(!!enabled))
  handle('library:set-options', (_e, patch: Partial<LibraryOptions>) => setLibraryOptions(patch ?? {}))
  handle('library:prioritize', (_e, courseId: string) => prioritizeCourse(safeId(courseId)))

  handle('characters:list', () => getCharacters())
  handle('characters:update', (_e, id: string, override: CharacterOverride) => {
    const settings = getSettings()
    const clean: CharacterOverride = {}
    for (const field of ['name', 'summary', 'persona', 'speech'] as const) {
      const value = override?.[field]
      if (typeof value === 'string' && value.trim()) clean[field] = value.trim().slice(0, 2000)
    }
    // 名前や話し方の書きかえは、書いたときの言語のものとして覚える
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
  handle('settings:set', (_e, patch: Partial<Settings>) => {
    const allowed: Partial<Settings> = {}
    if (patch.ai) allowed.ai = patch.ai
    if (patch.characterId) allowed.characterId = patch.characterId
    if (patch.ruling) allowed.ruling = patch.ruling
    if (patch.keys && typeof patch.keys === 'object') {
      // 知っている操作の割り当てだけを受けつける
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
    // 文言は、アプリを開いた時点の言語で決まっているので、切りかえたら開き直す（自動確認では、開き直さずに終わる）
    if (language) {
      if (!process.env['MANABI_NO_RELAUNCH']) app.relaunch()
      setTimeout(() => app.quit(), 150)
    }
    return next
  })
  handle('ai:status', async () => linkStatus() ?? (await aiStatus()))
  // AI へのつなぎ方（API キー・Sign in with ChatGPT）。キーとトークンは、本体側だけが持つ
  /** つなぎ方に合わない AI が選ばれていたら、合うものに切りかえる（Sign in with ChatGPT は OpenAI の側だけ。キーが片方だけなら、その側） */
  const fitProvider = (link: AiLinkState): void => {
    const want = link.route === 'siwc' ? 'codex' : link.route === 'own-key' && link.anthropicKey !== link.openaiKey ? (link.anthropicKey ? 'claude' : 'codex') : null
    if (want && want !== getSettings().ai.provider) setSettings({ ai: want === 'claude' ? { provider: 'claude', model: 'sonnet', effort: 'medium' } : { provider: 'codex', model: '', effort: 'medium' } })
  }
  const linkChanged = (): AiLinkState => {
    const next = linkState()
    fitProvider(next)
    resetSessions()
    broadcast('settings', 'ai-link')
    return next
  }
  handle('ai:link:get', () => linkState())
  handle('ai:link:set', (_e, patch: AiLinkPatch) => {
    setLink(patch)
    return linkChanged()
  })
  handle('ai:link:signin', () => signIn(() => void linkChanged()))
  handle('ai:link:signout', async () => {
    await signOut()
    return linkChanged()
  })
  handle('ai:link:models', () => siwcModels().catch(() => []))

  // 表示倍率（画面ごと。100%〜400%）
  handle('zoom:get', (event) => zoomOf(viewOf(event)?.view ?? 'home'))
  handle('zoom:step', (event, direction: number) => {
    const view = viewOf(event)?.view ?? 'home'
    return setZoom(view, direction === 0 ? 1 : zoomOf(view) + (direction > 0 ? 0.1 : -0.1))
  })
  handle('zoom:set', (_e, view: ViewName, factor: number) => {
    if (!(view in VIEWS)) throw new Error(t('不明な画面です。'))
    return setZoom(view, factor)
  })

  // チャット（授業についての質問）と、ディベート中の先生への相談
  const relay = (event: IpcMainInvokeEvent, channel: string, characterId: string) => (messageId: string, full: string) => {
    if (!event.sender.isDestroyed()) event.sender.send('chat:delta', { lessonId: channel, characterId, messageId, text: full })
  }
  const cleanMessage = (text: string) => {
    const message = String(text ?? '').trim().slice(0, 4000)
    if (!message) throw new Error(t('メッセージを入力してください。'))
    return message
  }
  handle('chat:load', (_e, channel: string, characterId: string) => getChat(channel, characterId))
  handle('chat:send', async (event, lessonId: string, characterId: string, text: string) => {
    if (getActiveTest()) throw new Error(t('テストの途中は質問できません。'))
    const added = await sendChat(safeId(lessonId), safeId(characterId), cleanMessage(text), relay(event, lessonId, characterId))
    broadcast('chat')
    return added
  })
  handle('chat:clear', async (_e, channel: string, characterId: string) => {
    await clearChat(safeId(channel), safeId(characterId))
    broadcast('chat')
  })
  // ディベート
  handle('debate:list', () => listDebates())
  handle('debate:get', (_e, id: string) => getDebate(id))
  handle('debate:topic', () => suggestTopic())
  handle('debate:start', (_e, setup: DebateSetup) => startDebate(setup))
  handle('debate:advance', async (_e, id: string, text: string | null) => {
    if (getActiveTest()) throw new Error(t('テストの途中はディベートできません。'))
    // ユーザーの発言、相手の発言、判定と進むたびに、画面へ途中経過を知らせる
    const session = await advanceDebate(safeId(id), typeof text === 'string' ? text : null, () => broadcast('debate'))
    broadcast('debate', 'skills')
    return session
  })
  handle('debate:coach', async (event, id: string, text: string) => {
    const session = getDebate(safeId(id))
    if (!session) throw new Error(t('ディベートが見つかりません。'))
    return sendCoach(debateBrief(session), cleanMessage(text), relay(event, COACH_CHANNEL, coach().id))
  })
  handle('skills:get', () => getSkills())

  // 英会話
  handle('eikaiwa:level', () => eikaiwaLevel())
  handle('eikaiwa:translate', (_e, text: string) => {
    if (getActiveTest()) throw new Error(t('テストの途中は英会話できません。'))
    return toEnglish(cleanMessage(text).slice(0, 400))
  })
  handle('eikaiwa:say', async (event, characterId: string, text: string) => {
    if (getActiveTest()) throw new Error(t('テストの途中は英会話できません。'))
    const added = await sayInEikaiwa(safeId(characterId), cleanMessage(text).slice(0, 400), relay(event, EIKAIWA_CHANNEL, characterId))
    broadcast('chat', 'skills')
    return added
  })

  // 音声認識（マイクの声を、この PC の中で文字にする）
  handle('speech:status', () => speechStatus())
  handle('speech:install', async (_e, model: SpeechModelId) => {
    await installSpeech(model)
    broadcast('speech', 'settings')
    return speechStatus()
  })
  handle('speech:choose', (_e, model: SpeechModelId) => {
    const status = chooseSpeechModel(model)
    broadcast('speech', 'settings')
    return status
  })
  handle('speech:transcribe', (_e, wav: ArrayBuffer, lang: string) => transcribe(new Uint8Array(wav), lang === 'en' ? 'en' : lang === 'auto' ? 'auto' : 'ja'))

  // 英語の読み上げ（画面側に英語の音声が無いときの予備）
  handle('tts:status', () => systemVoiceReady())
  handle('tts:speak', (_e, text: string) => systemSpeak(String(text ?? '')))
  handle('tts:stop', () => systemStop())

  // 漢字特訓
  const kanjiChanged = () => broadcast('kanji')
  handle('kanji:state', () => kanjiState())
  handle('kanji:count', (_e, setup: KanjiSetup) => kanjiCount(setup))
  handle('kanji:start', async (_e, setup: KanjiSetup) => {
    if (getActiveTest()) throw new Error(t('テストの途中は特訓できません。'))
    const state = startKanji(setup, kanjiChanged)
    kanjiChanged()
    // 書き順のウィンドウと、書きこむノートのウィンドウを開く
    await openView('kanjiOrder')
    await openView('kanjiNote')
    return state
  })
  handle('kanji:written', (_e, count: number) => {
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
    for (const key of ['kanjiOrder', 'kanjiNote']) {
      const found = openViews.get(key)
      if (found && !found.window.isDestroyed()) found.window.close()
    }
    kanjiChanged()
    return state
  })

  // 語彙力特訓
  const vocabChanged = () => broadcast('vocab')
  handle('vocab:state', () => vocabState())
  handle('vocab:mode', (_e, mode: 'own' | 'copy') => {
    const state = setVocabMode(mode)
    vocabChanged()
    return state
  })
  handle('vocab:start', async (_e, lang: VocabLang, levelId: string) => {
    if (getActiveTest()) throw new Error(t('テストの途中は特訓できません。'))
    const state = await startVocab(lang === 'en' ? 'en' : 'ja', String(levelId), vocabChanged)
    // 練習用のノートを、もう 1 つのウィンドウに開く
    if (state.notebookId) await openView('note', { notebookId: state.notebookId })
    return state
  })
  handle('vocab:check', async (_e, images: string[]) => {
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
  handle('notes:get', (_e, id: string) => {
    if (!allowedDuringTest('note', { notebookId: id })) throw new Error(t('テストが終わるまで、ほかのノートは開けません。'))
    return getNotebook(id)
  })
  handle('notes:save', async (_e, notebook: Notebook) => {
    safeId(notebook?.id)
    if (!Array.isArray(notebook.pages)) throw new Error(t('ノートの形式が正しくありません。'))
    await saveNotebook(notebook)
    broadcast('notes')
  })
  handle('notes:evaluations', (_e, notebookId: string) => getEvaluations(notebookId))
  handle('notes:evaluate', async (_e, request: EvaluateRequest) => {
    const result = await evaluateNote(request)
    broadcast('evaluations', 'report')
    return result
  })
  // メモ（授業と関係なく使うノート）
  handle('notes:create-memo', async (_e, title: string) => {
    if (getActiveTest()) throw new Error(t('テストの途中は、メモを作れません。'))
    const name = String(title ?? '').trim().slice(0, 60) || t('無題のメモ')
    const notebook = await createNotebook(name, null, 'memo')
    broadcast('notes')
    return listNotebooks().find((n) => n.id === notebook.id)
  })
  handle('notes:delete-memo', (_e, id: string) => {
    const key = `note:${safeId(id)}`
    const open = openViews.get(key)
    if (open && !open.window.isDestroyed()) open.window.destroy()
    deleteMemo(safeId(id))
    broadcast('notes')
  })
  // 手書きの文字起こし（評価はしない）
  handle('notes:transcribe', (_e, request: EvaluateRequest) => {
    if (getActiveTest()) throw new Error(t('テストの途中は、文字起こしできません。'))
    return transcribeNote(request)
  })
  handle('notes:save-transcripts', async (_e, id: string, results: { pageId: string; stamp: string; text: string }[]) => {
    const written = await saveTranscripts(safeId(id), Array.isArray(results) ? results : [])
    // 開いているノートの画面にも、文字起こしが入ったことを知らせる
    if (written) broadcast('notes', `transcript:${id}`)
    return written
  })
  handle('notes:export-pdf', async (event, title: string, images: string[]) => {
    // 自動確認では保存先の選択画面を出さずに、指定された場所へ書き出す
    const testPath = process.env['MANABI_PDF_PATH']
    if (testPath) {
      await writeFile(testPath, await buildPdf(title, images))
      return { saved: true, path: testPath }
    }
    return exportPdf(BrowserWindow.fromWebContents(event.sender), String(title), images)
  })

  // ノートに貼る画像・動画・リンク
  const ownerOf = (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender)
  handle('attachments:pick-image', (event) => pickImage(ownerOf(event)))
  handle('attachments:pick-video', (event) => pickVideo(ownerOf(event)))
  handle('attachments:data', (_e, attachmentId: string) => attachmentDataUrl(String(attachmentId)))
  handle('attachments:open', (_e, kind: 'link' | 'video', target: string) => {
    if (getActiveTest()) throw new Error(t('テストの途中は開けません。'))
    return openTarget(kind === 'video' ? 'video' : 'link', String(target))
  })

  // テスト
  handle('test:active', () => getActiveTest())
  handle('test:start', async (_e, setup: TestSetup) => {
    const session = await startTest(setup)
    // テストが始まったら、教科書・ディベート・ノートなどを閉じる
    closeAllExcept('test')
    broadcast('test')
    return session
  })
  handle('test:submit', async (_e, answers: Record<string, string>) => {
    const result = await submitTest(answers ?? {})
    broadcast('test', 'report')
    return result
  })
  handle('test:abort', () => {
    abortTest()
    closeAllExcept('test')
    broadcast('test')
  })
  handle('test:results', () => listTestResults())
  handle('test:result', (_e, id: string) => getTestResult(id))

  // 記述・論述の練習
  handle('essay:get', (_e, lessonId: string, variant?: LessonVariant) => getEssaySet(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard'))
  handle('essay:make', async (_e, lessonId: string, variant?: LessonVariant) => {
    if (getActiveTest()) throw new Error(t('テストの途中は、作れません。'))
    const set = await makeEssaySet(safeId(lessonId), variant === 'deep' ? 'deep' : 'standard')
    broadcast('essay')
    return set
  })
  handle('essay:review', async (_e, request: EssayReviewRequest) => {
    if (getActiveTest()) throw new Error(t('テストの途中は、練習できません。'))
    const attempt = await reviewEssay(request ?? { kind: 'short', question: '' })
    broadcast('essay')
    return attempt
  })
  handle('essay:attempts', (_e, lessonId?: string) => listEssayAttempts(lessonId ? safeId(lessonId) : undefined))

  // 週ごとの評価
  handle('report:subjects', () => activeSubjects())
  handle('report:list', (_e, subjectId: string) => listReports(safeId(subjectId)))
  handle('report:comment', async (_e, weekStart: string, subjectId: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekStart))) throw new Error(t('週の指定が正しくありません。'))
    const report = await commentOnWeek(weekStart, safeId(subjectId))
    broadcast('report')
    return report
  })
}

// ───────── アプリの起動と終了 ─────────

// 自動確認のときは、アプリ内部のファイルも別の場所に置く。
// こうすると二重起動の判定も別になり、ふだん使っているアプリを開いたままでも確認を実行できる。
const testDataDir = process.env['MANABI_DATA_DIR']
if (testDataDir) app.setPath('userData', join(testDataDir, 'electron'))

// 自動確認用: 本物のマイクの代わりに、音声ファイルをマイクの入力として使う
const fakeMic = process.env['MANABI_FAKE_MIC']
if (fakeMic) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', fakeMic)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => void openView('home'))

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    migrateCharacters()
    registerHandlers()
    onSpeechChanged(() => broadcast('speech'))

    // 学習用のウィンドウが手前にあり、操作が続いている間だけ、学習時間として数える
    startUsageTracking(() => {
      const focused = BrowserWindow.getFocusedWindow()
      const found = focused && [...openViews.values()].find((v) => v.window === focused)
      if (!found || !STUDY_VIEWS.includes(found.view)) return null
      if (found.view === 'test') return getActiveTest()?.subjectId ?? null
      const lessonId = found.view === 'note' ? getNotebook(found.params.notebookId ?? '')?.lessonId : found.params.lessonId
      return subjectOfLesson(lessonId ?? null)
    })

    // 教材づくりの進み具合を画面へ知らせる（細かく知らせすぎないよう、1 秒に 1 回まで）
    let pending = false
    startLibrary(() => {
      if (pending) return
      pending = true
      setTimeout(() => {
        pending = false
        broadcast('library', 'content')
      }, 1000)
    })

    // 終わった週の評価を確定する（起動時と、起動中は 1 時間ごと）
    const settle = () => settleWeeks() && broadcast('report')
    settle()
    setInterval(settle, 60 * 60 * 1000).unref()

    // インストーラーに入っている教材を、データの置き場へ写す（はじめて開いたときと、教材の版が変わったときだけ）
    const closeSplash = await importPack()

    // テストの途中でアプリを閉じていた場合は、テストの画面から再開する
    await openView(getActiveTest() ? 'test' : 'home')
    closeSplash()
  })

  app.on('window-all-closed', () => app.quit())

  let quitting = false
  app.on('before-quit', (event) => {
    closeAllSessions()
    stopSpeechServer()
    closeTts()
    if (quitting) return
    // 書き込み途中のノートを失わないよう、保存が終わるのを待ってから終了する
    quitting = true
    event.preventDefault()
    void flushWrites().finally(() => app.quit())
  })
}
