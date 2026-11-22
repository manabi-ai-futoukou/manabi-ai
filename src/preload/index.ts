import { contextBridge, ipcRenderer } from 'electron'
import type {
  AiLinkPatch,
  AiLinkState,
  AiStatus,
  CharacterDef,
  CharacterOverride,
  ChatDelta,
  ChatLog,
  ChatMessage,
  Course,
  Curriculum,
  DebateSession,
  DebateSetup,
  EikaiwaLevel,
  EssayAttempt,
  EssayReviewRequest,
  EvaluateRequest,
  EvaluateResult,
  GlossaryEntry,
  GlossaryList,
  GlossaryQuery,
  KanjiSetup,
  KanjiState,
  Lesson,
  LessonLinks,
  LessonVariant,
  LibraryOptions,
  LibraryState,
  MediaInfo,
  NoteEvaluation,
  Notebook,
  NotebookSummary,
  SearchQuery,
  SearchResult,
  Settings,
  SkillState,
  SpeechModelId,
  SpeechStatus,
  TestResult,
  TestSession,
  TestSetup,
  TimelineData,
  TranscribeResult,
  ViewName,
  ViewParams,
  VocabLang,
  VocabState,
  WeeklyReport,
} from '@shared/types'
import type { LessonAnnotation } from '@shared/annotate'
import type { EssayProblemSet } from '@shared/essay'
import type { VideoInfo, VideoProgress } from '@shared/video'

/** メインプロセスからの通知を購読する。戻り値を呼ぶと購読をやめる。 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: unknown, payload: T) => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api = {
  /** 表示する言語（ウィンドウを開いた時点の設定。文言を決める前に要るので、待たずに受け取る） */
  lang: String(ipcRenderer.sendSync('i18n:lang') ?? 'ja'),
  /** 教材づくりと、掛け合い・動く図解の作り直しを出すか（開発用の版だけ。配る版では出さない） */
  authoring: ipcRenderer.sendSync('app:authoring') === true,
  view: {
    get: (): Promise<{ view: ViewName; params: ViewParams }> => ipcRenderer.invoke('view:get'),
    open: (view: ViewName, params: ViewParams = {}): Promise<void> => ipcRenderer.invoke('view:open', view, params),
    onParams: (listener: (params: ViewParams) => void) => subscribe('view:params', listener),
    /** いま開いている授業を知らせる（学習時間をどの教科として数えるかに使われる） */
    context: (patch: ViewParams): Promise<void> => ipcRenderer.invoke('view:context', patch),
    /** この画面を、左または右に固定する（null で、固定をやめる）。固定した画面は、ほかの画面を開いても閉じず、ほかの画面は反対側に開く */
    pin: (side: 'left' | 'right' | null): Promise<'left' | 'right' | null> => ipcRenderer.invoke('view:pin', side),
    /** この画面が固定されている側（固定されていなければ null） */
    pinned: (): Promise<'left' | 'right' | null> => ipcRenderer.invoke('view:pinned'),
  },
  content: {
    courses: (): Promise<Course[]> => ipcRenderer.invoke('content:courses'),
    /** 科目の単元表。まだ作られていなければ null。 */
    curriculum: (courseId: string): Promise<Curriculum | null> => ipcRenderer.invoke('content:curriculum', courseId),
    ensureCurriculum: (courseId: string): Promise<Curriculum | null> => ipcRenderer.invoke('content:ensure-curriculum', courseId),
    lesson: (lessonId: string, variant?: LessonVariant): Promise<Lesson | null> => ipcRenderer.invoke('content:lesson', lessonId, variant),
    generate: (lessonId: string, variant?: LessonVariant): Promise<Lesson> => ipcRenderer.invoke('content:generate', lessonId, variant),
    /** できあがっている授業に、先生と同級生の掛け合いを足す（redo が真なら作り直す） */
    talk: (lessonId: string, variant?: LessonVariant, redo?: boolean): Promise<Lesson> => ipcRenderer.invoke('content:talk', lessonId, variant, redo),
    /** できあがっている授業に、合う「動く図解」があれば足す。added は、足したかどうか（合うものが無ければ偽） */
    sim: (lessonId: string, variant?: LessonVariant, redo?: boolean): Promise<{ lesson: Lesson; added: boolean }> => ipcRenderer.invoke('content:sim', lessonId, variant, redo),
    /** 掛け合いに出てくる歴史上の人物の、名前の訳（日本語の名前 → 訳。日本語で表示しているときは空） */
    personNames: (): Promise<Record<string, string>> => ipcRenderer.invoke('content:person-names'),
    /** 訳がまだ無い授業を、いまの表示の言語に訳す */
    translate: (lessonId: string, variant?: LessonVariant): Promise<Lesson> => ipcRenderer.invoke('content:translate', lessonId, variant),
  },
  /** 授業ごとの注釈（用語・ふりがな・前提と関連）と、それをまとめた用語集・年表・検索 */
  annot: {
    /** その授業の注釈。まだ作られていなければ null */
    get: (lessonId: string, variant?: LessonVariant): Promise<LessonAnnotation | null> => ipcRenderer.invoke('annot:get', lessonId, variant),
    /** その授業の注釈を、いま AI に作ってもらう */
    make: (lessonId: string, variant?: LessonVariant): Promise<LessonAnnotation> => ipcRenderer.invoke('annot:make', lessonId, variant),
    /** その授業の、前提の授業と、関連する授業 */
    links: (lessonId: string, variant?: LessonVariant): Promise<LessonLinks> => ipcRenderer.invoke('annot:links', lessonId, variant),
    glossary: (query: GlossaryQuery): Promise<GlossaryList> => ipcRenderer.invoke('annot:glossary', query),
    term: (term: string): Promise<GlossaryEntry | null> => ipcRenderer.invoke('annot:term', term),
    timeline: (): Promise<TimelineData | null> => ipcRenderer.invoke('annot:timeline'),
    search: (query: SearchQuery): Promise<SearchResult> => ipcRenderer.invoke('annot:search', query),
  },
  media: {
    /** 授業の挿絵（本文の ```picture の id で引く）。無ければ null */
    picture: (id: string): Promise<MediaInfo | null> => ipcRenderer.invoke('media:picture', id),
    /** 歴史上の人物などの絵（掛け合いに出てくる名前で引く）。無ければ null */
    person: (name: string): Promise<MediaInfo | null> => ipcRenderer.invoke('media:person', name),
  },
  /** 授業の動画（試作） */
  video: {
    /** その授業の動画（台本と音声の長さ）。まだ無ければ null */
    get: (lessonId: string, variant?: LessonVariant): Promise<VideoInfo | null> => ipcRenderer.invoke('video:get', lessonId, variant),
    /** 読み上げソフトが使えるか */
    voice: (): Promise<{ ready: boolean; voice: string }> => ipcRenderer.invoke('video:voice'),
    /** 動画を作る（台本 → 声）。redo が真なら、台本から作り直す */
    make: (lessonId: string, variant?: LessonVariant, redo?: boolean): Promise<VideoInfo> => ipcRenderer.invoke('video:make', lessonId, variant, redo),
    onProgress: (listener: (progress: VideoProgress) => void) => subscribe('video:progress', listener),
    /** せりふ 1 つぶんの音声 */
    audio: (lessonId: string, variant: LessonVariant | undefined, index: number): Promise<string> => ipcRenderer.invoke('video:audio', lessonId, variant, index),
    /** 録画したデータを、動画ファイルに書き出す */
    record: (lessonId: string, variant: LessonVariant | undefined, action: 'start' | 'chunk' | 'end' | 'cancel', chunk?: ArrayBuffer): Promise<string> =>
      ipcRenderer.invoke('video:record', lessonId, variant, action, chunk),
    /** 書き出した動画ファイルを、フォルダで表示する */
    reveal: (lessonId: string, variant?: LessonVariant): Promise<void> => ipcRenderer.invoke('video:reveal', lessonId, variant),
  },
  library: {
    get: (): Promise<LibraryState> => ipcRenderer.invoke('library:get'),
    setEnabled: (enabled: boolean): Promise<void> => ipcRenderer.invoke('library:set-enabled', enabled),
    setOptions: (patch: Partial<LibraryOptions>): Promise<void> => ipcRenderer.invoke('library:set-options', patch),
    prioritize: (courseId: string): Promise<void> => ipcRenderer.invoke('library:prioritize', courseId),
  },
  characters: {
    list: (): Promise<CharacterDef[]> => ipcRenderer.invoke('characters:list'),
    update: (id: string, override: CharacterOverride): Promise<CharacterDef[]> =>
      ipcRenderer.invoke('characters:update', id, override),
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:set', patch),
  },
  ai: {
    status: (): Promise<AiStatus> => ipcRenderer.invoke('ai:status'),
    /** AI へのつなぎ方（Windows 版の設定の画面。Web 版では get が null を返す） */
    link: {
      get: (): Promise<AiLinkState | null> => ipcRenderer.invoke('ai:link:get'),
      set: (patch: AiLinkPatch): Promise<AiLinkState> => ipcRenderer.invoke('ai:link:set', patch),
      /** Sign in with ChatGPT を始める（いつものブラウザが開く。終わると「ai-link」の知らせが届く） */
      signIn: (): Promise<void> => ipcRenderer.invoke('ai:link:signin'),
      signOut: (): Promise<AiLinkState> => ipcRenderer.invoke('ai:link:signout'),
      models: (): Promise<{ slug: string; name: string }[]> => ipcRenderer.invoke('ai:link:models'),
    },
  },
  zoom: {
    /** このウィンドウの表示倍率（1 = 100%） */
    get: (): Promise<number> => ipcRenderer.invoke('zoom:get'),
    /** このウィンドウの表示倍率を 10% 上げる（1）・下げる（-1）・100% にもどす（0） */
    step: (direction: -1 | 0 | 1): Promise<number> => ipcRenderer.invoke('zoom:step', direction),
    /** 指定した画面（モード）の表示倍率を決める */
    set: (view: ViewName, factor: number): Promise<number> => ipcRenderer.invoke('zoom:set', view, factor),
  },
  chat: {
    load: (lessonId: string, characterId: string): Promise<ChatLog> => ipcRenderer.invoke('chat:load', lessonId, characterId),
    send: (lessonId: string, characterId: string, text: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke('chat:send', lessonId, characterId, text),
    clear: (lessonId: string, characterId: string): Promise<void> => ipcRenderer.invoke('chat:clear', lessonId, characterId),
    onDelta: (listener: (delta: ChatDelta) => void) => subscribe('chat:delta', listener),
  },
  notes: {
    list: (): Promise<NotebookSummary[]> => ipcRenderer.invoke('notes:list'),
    get: (id: string): Promise<Notebook | null> => ipcRenderer.invoke('notes:get', id),
    save: (notebook: Notebook): Promise<void> => ipcRenderer.invoke('notes:save', notebook),
    evaluations: (notebookId: string): Promise<NoteEvaluation[]> => ipcRenderer.invoke('notes:evaluations', notebookId),
    evaluate: (request: EvaluateRequest): Promise<EvaluateResult> => ipcRenderer.invoke('notes:evaluate', request),
    /** 新しいメモ（授業と関係なく使うノート）を作る */
    createMemo: (title: string): Promise<NotebookSummary> => ipcRenderer.invoke('notes:create-memo', title),
    /** メモを消す（メモだけ。授業のノートは消せない） */
    deleteMemo: (id: string): Promise<void> => ipcRenderer.invoke('notes:delete-memo', id),
    /** 手書きの文字起こしだけをする（評価はしない）。渡すのは、手書きの線だけを描いたページの画像 */
    transcribe: (request: EvaluateRequest): Promise<TranscribeResult> => ipcRenderer.invoke('notes:transcribe', request),
    /** 文字起こしの結果だけを、保存してあるノートに書きこむ（まとめて文字起こしするとき）。書きこめたページの数を返す */
    saveTranscripts: (id: string, results: { pageId: string; stamp: string; text: string }[]): Promise<number> => ipcRenderer.invoke('notes:save-transcripts', id, results),
    exportPdf: (title: string, images: string[]): Promise<{ saved: boolean; path?: string }> =>
      ipcRenderer.invoke('notes:export-pdf', title, images),
  },
  attachments: {
    /** 画像を選んで取りこむ。選ばなかった場合は null。 */
    pickImage: (): Promise<{ attachmentId: string; name: string; width: number; height: number } | null> =>
      ipcRenderer.invoke('attachments:pick-image'),
    pickVideo: (): Promise<{ path: string; name: string } | null> => ipcRenderer.invoke('attachments:pick-video'),
    data: (attachmentId: string): Promise<string | null> => ipcRenderer.invoke('attachments:data', attachmentId),
    open: (kind: 'link' | 'video', target: string): Promise<void> => ipcRenderer.invoke('attachments:open', kind, target),
  },
  debate: {
    list: (): Promise<DebateSession[]> => ipcRenderer.invoke('debate:list'),
    get: (id: string): Promise<DebateSession | null> => ipcRenderer.invoke('debate:get', id),
    /** AI に論題を考えてもらう */
    topic: (): Promise<string> => ipcRenderer.invoke('debate:topic'),
    start: (setup: DebateSetup): Promise<DebateSession> => ipcRenderer.invoke('debate:start', setup),
    /** text があれば自分の発言として進める。null なら、相手の番や判定だけを進める。 */
    advance: (id: string, text: string | null): Promise<DebateSession> => ipcRenderer.invoke('debate:advance', id, text),
    /** ディベートの途中で、先生に相談する */
    coach: (id: string, text: string): Promise<ChatMessage[]> => ipcRenderer.invoke('debate:coach', id, text),
  },
  skills: {
    get: (): Promise<SkillState> => ipcRenderer.invoke('skills:get'),
  },
  eikaiwa: {
    /** いまの会話のレベル（英語の授業の進み具合から決まる） */
    level: (): Promise<EikaiwaLevel> => ipcRenderer.invoke('eikaiwa:level'),
    /** 日本語で書いた「言いたいこと」を、いまのレベルの英語にする */
    translate: (text: string): Promise<string> => ipcRenderer.invoke('eikaiwa:translate', text),
    /** 声に出して言えた英文を、相手に送る */
    say: (characterId: string, text: string): Promise<ChatMessage[]> => ipcRenderer.invoke('eikaiwa:say', characterId, text),
  },
  speech: {
    status: (): Promise<SpeechStatus> => ipcRenderer.invoke('speech:status'),
    /** 音声認識のエンジンとモデルを取り寄せる（大きなダウンロード） */
    install: (model: SpeechModelId): Promise<SpeechStatus> => ipcRenderer.invoke('speech:install', model),
    choose: (model: SpeechModelId): Promise<SpeechStatus> => ipcRenderer.invoke('speech:choose', model),
    /** 録音（16kHz・モノラルの WAV）を文字にする */
    transcribe: (wav: ArrayBuffer, lang: 'ja' | 'en' | 'auto'): Promise<string> => ipcRenderer.invoke('speech:transcribe', wav, lang),
  },
  tts: {
    /** 英語を読み上げられる音声（Windows の従来の系統）が、この PC に入っているか */
    status: (): Promise<boolean> => ipcRenderer.invoke('tts:status'),
    speak: (text: string): Promise<void> => ipcRenderer.invoke('tts:speak', text),
    stop: (): Promise<void> => ipcRenderer.invoke('tts:stop'),
  },
  kanji: {
    state: (): Promise<KanjiState> => ipcRenderer.invoke('kanji:state'),
    /** その条件に合う漢字の数と、クリア済みの数 */
    count: (setup: KanjiSetup): Promise<{ total: number; done: number }> => ipcRenderer.invoke('kanji:count', setup),
    /** 特訓を始める。書き順とノートのウィンドウも開く */
    start: (setup: KanjiSetup): Promise<KanjiState> => ipcRenderer.invoke('kanji:start', setup),
    /** ノートのウィンドウから: 正しい書き順で書けた回数を知らせる */
    written: (count: number): Promise<void> => ipcRenderer.invoke('kanji:written', count),
    /** 1 字クリアして、次の漢字へ進む */
    clear: (): Promise<KanjiState> => ipcRenderer.invoke('kanji:clear'),
    skip: (): Promise<KanjiState> => ipcRenderer.invoke('kanji:skip'),
    retryWords: (): Promise<KanjiState> => ipcRenderer.invoke('kanji:retry-words'),
    stop: (): Promise<KanjiState> => ipcRenderer.invoke('kanji:stop'),
  },
  vocab: {
    state: (): Promise<VocabState> => ipcRenderer.invoke('vocab:state'),
    /** 特訓を始める。言葉が足りなければ AI が用意し、練習用のノートも開く */
    start: (lang: VocabLang, levelId: string): Promise<VocabState> => ipcRenderer.invoke('vocab:start', lang, levelId),
    /** ノートのページ（PNG の data URL）を AI に見せて、確かめてもらう */
    check: (images: string[]): Promise<VocabState> => ipcRenderer.invoke('vocab:check', images),
    /** 例文の決まりを切りかえる（own: 自分で考える / copy: お手本を書き写してよい） */
    setMode: (mode: 'own' | 'copy'): Promise<VocabState> => ipcRenderer.invoke('vocab:mode', mode),
    skip: (): Promise<VocabState> => ipcRenderer.invoke('vocab:skip'),
    stop: (): Promise<VocabState> => ipcRenderer.invoke('vocab:stop'),
  },
  test: {
    active: (): Promise<TestSession | null> => ipcRenderer.invoke('test:active'),
    start: (setup: TestSetup): Promise<TestSession> => ipcRenderer.invoke('test:start', setup),
    submit: (answers: Record<string, string>): Promise<TestResult> => ipcRenderer.invoke('test:submit', answers),
    abort: (): Promise<void> => ipcRenderer.invoke('test:abort'),
    results: (): Promise<TestResult[]> => ipcRenderer.invoke('test:results'),
    result: (id: string): Promise<TestResult | null> => ipcRenderer.invoke('test:result', id),
  },
  /** 記述・論述の練習 */
  essay: {
    /** その授業の、AI が前もって作った問題と解答例。まだ無ければ null */
    get: (lessonId: string, variant?: LessonVariant): Promise<EssayProblemSet | null> => ipcRenderer.invoke('essay:get', lessonId, variant),
    /** その授業の問題と解答例を、いま AI に作ってもらう */
    make: (lessonId: string, variant?: LessonVariant): Promise<EssayProblemSet> => ipcRenderer.invoke('essay:make', lessonId, variant),
    /** 書いた文章を、先生（AI）に見てもらう */
    review: (request: EssayReviewRequest): Promise<EssayAttempt> => ipcRenderer.invoke('essay:review', request),
    /** これまでに見てもらった記録（授業を指定すると、その授業のぶんだけ） */
    attempts: (lessonId?: string): Promise<EssayAttempt[]> => ipcRenderer.invoke('essay:attempts', lessonId),
  },
  report: {
    /** 学習の記録がある教科 */
    subjects: (): Promise<string[]> => ipcRenderer.invoke('report:subjects'),
    list: (subjectId: string): Promise<WeeklyReport[]> => ipcRenderer.invoke('report:list', subjectId),
    comment: (weekStart: string, subjectId: string): Promise<WeeklyReport> => ipcRenderer.invoke('report:comment', weekStart, subjectId),
  },
  /** ほかのウィンドウで何かが変わったときの通知（'settings' / 'chat' / 'content' など） */
  onChanged: (listener: (topic: string) => void) => subscribe('changed', listener),
}

export type ManabiApi = typeof api

contextBridge.exposeInMainWorld('manabi', api)
