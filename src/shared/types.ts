import { t, type Lang } from './i18n.ts'
/** メインプロセスと画面（レンダラー）の両方で使う型。 */

export type ViewName = 'home' | 'textbook' | 'chat' | 'debate' | 'note' | 'memo' | 'glossary' | 'search' | 'timeline' | 'essay' | 'test' | 'report' | 'library' | 'eikaiwa' | 'vocab' | 'kanji' | 'kanjiOrder' | 'kanjiNote' | 'settings' | 'video'

// ───────── 科目 ─────────

/**
 * hsp: 高校の専門教科（主として専門学科で開設される科目。商業、情報、福祉など）
 * univ: 大学（学部）、grad: 大学院（修士課程の講義科目）。教科（subject）は、学科や研究科にあたる
 */
export type SchoolId = 'es' | 'jhs' | 'hs' | 'hsp' | 'univ' | 'grad'

/**
 * いまは公開しない学校（大学・大学院）。教材と道具は残してあり、将来、公開する予定。
 * ここを空にすると、科目表にも画面にも、また出る（2026-11-22 の公開の準備で、一時的に非公開にした）
 */
export const HIDDEN_SCHOOLS: SchoolId[] = ['univ', 'grad']

/** 学校の並び順と、画面に出す名前（非公開の学校もふくむ） */
const ALL_SCHOOLS: [SchoolId, string][] = [
  ['es', t('小学校')],
  ['jhs', t('中学校')],
  ['hs', t('高校')],
  ['hsp', t('高校（専門）')],
  ['univ', t('大学')],
  ['grad', t('大学院')],
]

/** 画面に出す学校（並び順と名前） */
export const SCHOOLS: [SchoolId, string][] = ALL_SCHOOLS.filter(([id]) => !HIDDEN_SCHOOLS.includes(id))

/** 1 つの科目（例: 中学 2 年 数学、高校 数学 I）。学年や分野ごとに単元表を 1 つ持つ。 */
export interface Course {
  id: string
  school: SchoolId
  schoolLabel: string
  /** 教科の種類（math、japanese など） */
  subject: string
  subjectLabel: string
  /** 学年や科目名（「1 年」「数学 I」「歴史」など） */
  label: string
  /** 画面に出す名前（「中学 1 年 数学」など） */
  title: string
  /** 評価をまとめる単位（学校 + 教科。例: jhs-math） */
  subjectId: string
  /** 学習指導要領にもとづく、この科目で扱う内容 */
  scope: string
  /** 単元表を作るときの授業数の目安 */
  lessonTarget: number
  /** 小学校の科目は、小学生向けと学び直し向け（深掘り）の 2 種類の本文を持つ */
  hasDeep: boolean
  /** 本文を書かせるときの、教科ごとの指示の名前（ふつうは subject と同じ。「home+homepro」のように + でつなげられる） */
  guide: string
  /** 職業に関する専門科目（商業、情報、家庭、福祉など）。実習や資格の勉強の代わりにならないことを、画面で知らせる */
  vocational: boolean
  /** 大学・大学院の科目。全国共通の内容の決まりが無く、専門家の確認も受けていないことを、画面で知らせる */
  higher: boolean
  /** 実技（運動、演奏、制作）が中心の専門科目（高校の専門教科の体育・音楽・美術）。実技そのものは学べないことを、画面で知らせる */
  skill: boolean
  /** 学校では実習や課題研究として行う科目。アプリでは、進め方・記録・安全だけを扱う */
  practice: boolean
  /** 単元表があるか */
  hasCurriculum: boolean
  /** 本文がある授業の数と、授業の総数（単元表が無い間は目安の数） */
  ready: number
  total: number
}

export interface ExternalReview {
  /** 精査した人や AI の名前（codex など） */
  by: string
  at: number
  /** ok: 直すところなし / fixed: 直した / flag: 人に確かめてほしい点がある */
  verdict: 'ok' | 'fixed' | 'flag'
  note: string
}

/** standard: ふつうの本文 / deep: 小学校の内容を中学生以降が学び直すための深掘り版 */
export type LessonVariant = 'standard' | 'deep'

// ───────── 教材づくり（授業の一括作成） ─────────

export interface LibraryOptions {
  /** 作った授業を、もう一度 AI に点検させるか */
  review: boolean
  /** 5 時間あたりの使用量がこの割合に達したら休む（0〜1） */
  pauseAt: number
  /** 同時に作る数 */
  concurrency: number
  /** できあがった授業に、先生と同級生の掛け合いを足すか */
  talk: boolean
  /** できあがった授業（算数・数学・理科）に、合う「動く図解」があれば足すか */
  sims: boolean
}

export interface UsageWindow {
  /** 使用した割合（0〜1） */
  utilization: number
  /** 回復する時刻 */
  resetsAt: number
}

export interface LibraryState {
  enabled: boolean
  /** idle: 止まっている / running: 作成中 / paused: 使用量の上限に近いので休止中 / done: すべて完成 */
  status: 'idle' | 'running' | 'paused' | 'done'
  /** 休止している理由と、再開の予定時刻 */
  pauseReason: string | null
  resumeAt: number | null
  options: LibraryOptions
  /** いま作っているもの */
  current: string[]
  /** 最近の記録（新しい順） */
  recent: { at: number; text: string; ok: boolean }[]
  /** AI から最後に届いた使用量 */
  usage: { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null }
  /** 先に作る科目 */
  priority: string[]
  /** talks: 掛け合いが入っている授業の数 / talkTargets: 掛け合いを足せる授業（AI が作った本文。道徳をのぞく）の数 */
  totals: {
    courses: number
    curricula: number
    lessons: number
    ready: number
    talks: number
    talkTargets: number
    /** sims: 動く図解が入っている授業の数 / simChecked: 合う図解があるか調べ終えた授業の数 / simTargets: 調べる対象（算数・数学・理科の、AI が作った本文）の数 */
    sims: number
    simChecked: number
    simTargets: number
  }
}

/** 授業の挿絵や、歴史上の人物の絵。kind は、generated（AI が描いたイメージ）か public（公開されている肖像画や写真。credit が出典） */
export interface MediaInfo {
  /** 画像そのもの（data URL） */
  url: string
  kind: 'generated' | 'public'
  credit: string
  alt: string
  /** 公開されている画像の、もとのページ（出典を確かめられるように） */
  source: string
}

// ───────── キャラクター ─────────

export interface CharacterDef {
  id: string
  name: string
  role: 'teacher' | 'classmate'
  /** 画面に出す肩書き（「先生」「同級生」など） */
  roleLabel: string
  /** 画面に出す一言紹介 */
  summary: string
  /** 性格・背景。AI への指示に使う */
  persona: string
  /** 口調。AI への指示に使う */
  speech: string
  /** 表情名 → 画像ファイル名（characters/<id>/ 以下） */
  expressions: Record<string, string>
  /** 表情名 → どんなときに使うかの説明（AI への指示に使う） */
  expressionHints: Record<string, string>
  defaultExpression: string
  /** 全身の立ち絵 */
  full: string
}

/** ユーザーが書き換えられる項目 */
export type CharacterOverride = Partial<Pick<CharacterDef, 'name' | 'summary' | 'persona' | 'speech'>>

// ───────── AI ─────────

export type AiProviderId = 'claude' | 'codex'

export interface AiSettings {
  provider: AiProviderId
  /** claude: haiku / sonnet / opus など。codex: 空文字なら CLI の既定モデル */
  model: string
  /** 思考量 */
  effort: string
}

export interface Settings {
  ai: AiSettings
  /** ディベートモードで最後に選んだ相手 */
  characterId: string
  /** ホームで最後に開いていた科目 */
  courseId: string
  ruling: Ruling
  characterOverrides: Record<string, CharacterOverride>
  /** 日本語以外の表示のときに書きかえた、名前や話し方（言語 → 人物の ID → 書きかえ） */
  characterOverridesByLang?: Record<string, Record<string, CharacterOverride>>
  /** 画面ごとの表示倍率（1 = 100%。1〜4） */
  zoom: Record<string, number>
  /** 利用者が変えたショートカットキー（操作の ID → キーの組み合わせ。空文字は「割り当てなし」） */
  keys: Record<string, string>
  /** 音声認識に使うモデル */
  speechModel: SpeechModelId
  eikaiwa: EikaiwaSettings
  /** 表示する言語（切りかえると、アプリを開き直す） */
  language: Lang
  /** 教科書で、ふりがなを出すか */
  furigana: boolean
  /** 利き手（ノートを開く側と、ノートの道具の列の側を決める。右利きなら、どちらも右） */
  handedness: Handedness
}

/** 利き手 */
export type Handedness = 'right' | 'left'

// ───────── 教材 ─────────

export interface LessonMeta {
  id: string
  unitId: string
  /** 「1-2」のような表示用番号 */
  number: string
  title: string
  summary: string
  /** authored: 手書きで用意済み / generated: AI 生成済み / none: 未生成 */
  status: 'authored' | 'generated' | 'none'
  /** 小学校の科目だけ: 学び直し向け（深掘り）の本文があるか */
  deep?: boolean
}

export interface UnitMeta {
  id: string
  number: number
  /** 学習指導要領の領域（「A 数と式」など） */
  domain: string
  title: string
  summary: string
  lessons: LessonMeta[]
}

export interface Curriculum {
  /** 科目の ID */
  id: string
  title: string
  course: Course
  units: UnitMeta[]
}

export interface Lesson extends LessonMeta {
  courseId: string
  courseTitle: string
  unitTitle: string
  variant: LessonVariant
  /** AI が作った本文を、もう一度 AI が点検したか */
  reviewed: boolean
  /** 別の AI や人が、あとから精査した記録（scripts/mark-reviewed.mjs が書く） */
  externalReview?: ExternalReview
  /** Markdown 本文 */
  body: string
  /** 表示の言語が日本語でないとき: 訳がまだ無く、日本語の本文をそのまま見せている */
  untranslated?: boolean
  /** 表示の言語が日本語でないとき: 訳したあとに日本語の本文が書き直されていて、訳は書き直す前の内容のまま（日本語版と内容が異なる） */
  outdated?: boolean
}

// ───────── ディベート ─────────

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** assistant の発言に付いた表情 */
  expression?: string
  at: number
}

export interface ChatLog {
  lessonId: string
  characterId: string
  messages: ChatMessage[]
}

export interface ChatDelta {
  lessonId: string
  characterId: string
  messageId: string
  /** これまでに届いた全文（表情タグを含む生のテキスト） */
  text: string
}

// ───────── ノート ─────────

export interface Ruling {
  /** lined: 横罫（vertical が真なら縦罫）/ grid: 方眼 / plain: 無地 / english: 英語用の 4 線 */
  kind: 'lined' | 'grid' | 'plain' | 'english'
  /** 罫線の間隔（mm）。4 線では、4 本の線のまとまりの高さ */
  spacing: number
  /** 縦書き（罫線が縦になり、タイピングした文章も縦に流れる） */
  vertical?: boolean
}

export interface Stroke {
  id: string
  tool: 'pen' | 'marker'
  color: string
  /** 太さ（ページ座標。1 = 0.1mm） */
  size: number
  /** [x, y, 筆圧 0〜1] の並び */
  points: number[][]
  /** 筆圧つきのペンで書かれたか（マウスの場合は false） */
  pressure: boolean
  /** 消しゴムで一部を消した線。points は「太さを決めた後の点」で、そのまま描く（残った部分の見た目を変えないため） */
  baked?: boolean
}

export interface TextBox {
  id: string
  x: number
  y: number
  width: number
  text: string
  color: string
}

/** ページに置く部品（図形・表・座標平面・画像・リンク）。位置と大きさはページ座標（1 = 0.1mm）。 */
interface ObjectBase {
  id: string
  x: number
  y: number
  /** 線と矢印では、w・h が負になることがある（始点から終点への向き） */
  w: number
  h: number
}

export interface ShapeObject extends ObjectBase {
  type: 'shape'
  kind: 'line' | 'arrow' | 'rect' | 'ellipse'
  color: string
  size: number
}

export interface TableObject extends ObjectBase {
  type: 'table'
  /** 行 × 列の文字 */
  cells: string[][]
}

export interface GraphObject extends ObjectBase {
  type: 'graph'
  /** 座標軸の範囲（−range 〜 +range） */
  range: number
}

export interface ImageObject extends ObjectBase {
  type: 'image'
  /** アプリのデータ置き場に取りこんだ画像の ID */
  attachmentId: string
  name: string
}

export interface LinkObject extends ObjectBase {
  type: 'link'
  /** link: Web ページ / video: この PC にある動画ファイル */
  kind: 'link' | 'video'
  /** URL、または動画ファイルの場所 */
  target: string
  title: string
}

export type NoteObject = ShapeObject | TableObject | GraphObject | ImageObject | LinkObject

export interface NotePage {
  id: string
  strokes: Stroke[]
  texts: TextBox[]
  objects?: NoteObject[]
  /** タイピングモードで、罫線に沿って入力した文章 */
  typed?: string
  /** AI が読み取った手書きの内容（文字起こし。検索でき、書き直せる） */
  transcript?: string
  /** 文字起こしをしたときの、手書きの線の目印（inkStamp）。いまの線とちがえば、そのあとに書き足した・消したことが分かる */
  transcriptStamp?: string
}

/** ページの手書きの線の目印。線が増えた・減った・一部を消した、のどれでも変わる */
export const inkStamp = (page: Pick<NotePage, 'strokes'>): string => (page.strokes.length ? `${page.strokes.length}:${page.strokes[page.strokes.length - 1].id}` : '')

export interface Notebook {
  id: string
  title: string
  lessonId: string | null
  /**
   * test: テスト中だけ使う計算用のノート。先生の評価やほかのノートへの移動はできない。
   * drill: 特訓用のノート。「書けた！」で AI が確かめる。
   * memo: 授業と関係なく使うメモ。名前を付けて、いくつでも作れる。先生の評価は無い。
   */
  kind?: 'lesson' | 'test' | 'drill' | 'memo'
  /** 特訓用のノートが、どの特訓のものか */
  drill?: 'vocabJa' | 'vocabEn'
  ruling: Ruling
  pages: NotePage[]
  createdAt: number
  updatedAt: number
}

export interface NotebookSummary {
  id: string
  title: string
  lessonId: string | null
  kind: 'lesson' | 'test' | 'drill' | 'memo'
  pageCount: number
  updatedAt: number
  /** 手書きのあるページの数と、そのうち、いまの手書きを文字起こし済みのページの数 */
  inkPages: number
  transcribedPages: number
}

// ───────── ノートの評価 ─────────

export interface AxisScore {
  score: number
  comment: string
}

export interface NoteEvaluation {
  id: string
  notebookId: string
  lessonId: string | null
  at: number
  ai: AiSettings
  evaluatorId: string
  /** 理解力 */
  understanding: AxisScore
  /** 応用力 */
  application: AxisScore
  /** 発想力 */
  creativity: AxisScore
  overall: string
  advice: string
  /** 教科書・ディベートの文章と一致した割合（0〜1）。参考値 */
  copyRate: number | null
  /** 評価に使ったページ番号（1 始まり） */
  pages: number[]
}

export interface EvaluateRequest {
  notebookId: string
  /** ページ番号（1 始まり）と、そのページを画像化した PNG の data URL */
  pages: { page: number; image: string }[]
}

/** 文字起こしの結果（ページ番号 → 読み取った内容） */
export type TranscribeResult = Record<number, string>

export interface EvaluateResult {
  evaluation: NoteEvaluation
  /** ページ番号 → 読み取った内容 */
  transcripts: Record<number, string>
  /** この評価で増えた好感度（全員ぶん） */
  reward: number
}

// ───────── テスト ─────────

export type QuestionKind = 'choice' | 'short' | 'written' | 'essay'

/**
 * テストの形式（特化モード）。
 * mixed: いろいろな形式（選択・短答・記述） / choice: 選択だけ / written: 記述だけ（100 字ほどで説明する） / essay: 論述だけ（序論・本論・結論で、数百〜千字）
 */
export type TestFormat = 'mixed' | 'choice' | 'written' | 'essay'

export interface TestQuestion {
  id: string
  /** choice: 4 つから選ぶ / short: 数や式を短く答える / written: 文章で説明する（記述） / essay: 序論・本論・結論で論じる（論述） */
  kind: QuestionKind
  /** 問題文（Markdown + 数式） */
  prompt: string
  choices: string[]
  points: number
}

export interface TestSetup {
  courseId: string
  unitId: string
  /** 出題範囲にする授業 */
  lessonIds: string[]
  questionCount: number
  /** 制限時間（分）。null なら時間を計らない */
  timeLimitMin: number | null
  /** 形式（指定しなければ、いろいろな形式） */
  format?: TestFormat
}

/** 受けている途中のテスト。正解は画面側に渡さない。 */
export interface TestSession {
  id: string
  subjectId: string
  unitId: string
  unitTitle: string
  lessonIds: string[]
  questions: TestQuestion[]
  timeLimitMin: number | null
  startedAt: number
  /** 計算用ノート */
  notebookId: string
  format?: TestFormat
  /** 記述・論述の字数の目安（[少なくとも, 多くても]） */
  lengths?: { written: [number, number]; essay: [number, number] }
}

export interface TestQuestionResult {
  question: TestQuestion
  answer: string
  correctAnswer: string
  explanation: string
  score: number
  feedback: string
}

export interface TestResult {
  id: string
  subjectId: string
  unitId: string
  unitTitle: string
  lessonIds: string[]
  startedAt: number
  finishedAt: number
  timeLimitMin: number | null
  /** 100 点満点 */
  score: number
  results: TestQuestionResult[]
  comment: string
  notebookId: string
  ai: AiSettings
}

// ───────── 記述・論述の練習 ─────────

export interface EssayReviewRequest {
  lessonId?: string
  variant?: LessonVariant
  /** short: 記述 / long: 論述 */
  kind: 'short' | 'long'
  question: string
  /** 採点で見る要点（AI が作った問題のとき） */
  points?: string[]
  /** 記述の文章 */
  text?: string
  /** 論述の文章（序論・本論・結論） */
  parts?: { intro: string; body: string; conclusion: string }
}

/** 先生（AI）に見てもらった記録 */
export interface EssayAttempt {
  id: string
  at: number
  lessonId: string | null
  lessonTitle: string
  kind: 'short' | 'long'
  question: string
  text: string
  /** 100 点満点 */
  score: number
  good: string
  improve: string
  example: string
}

// ───────── 週ごとの評価 ─────────

export type AxisKey = 'understanding' | 'application' | 'creativity' | 'memory' | 'persistence'

export interface AxisValue {
  /** 100 点満点。その週に材料が無い場合は null */
  score: number | null
  /** 何をもとに出した点か */
  basis: string
}

export interface WeeklyReport {
  /** 週の始まり（月曜日）の日付。YYYY-MM-DD */
  weekStart: string
  weekEnd: string
  subjectId: string
  subjectTitle: string
  axes: Record<AxisKey, AxisValue>
  overall: number | null
  /** 曜日ごとの学習時間（分）。月曜から日曜の 7 つ */
  dailyMinutes: number[]
  activeMinutes: number
  activeDays: number
  noteCount: number
  testCount: number
  /** 週が終わって確定したか */
  final: boolean
  /** 確定したときに全員へ配られた好感度 */
  bonus: number | null
  /** 先生の講評（頼んだときだけ作られる） */
  comment: string | null
}

// ───────── 好感度 ─────────

export interface AffinityEntry {
  id: string
  at: number
  /** 'all' は全員 */
  characterId: string
  delta: number
  reason: string
}

export interface AffinityState {
  /** キャラクター ID → 好感度（0〜max） */
  gauges: Record<string, number>
  max: number
  /** 1 回話しかけるのに使う量 */
  talkCost: number
  recent: AffinityEntry[]
}

// ───────── 5 つの力 ─────────

/** 教科とは別に育つ力。ディベート・英会話・漢字特訓・語彙力特訓の成果で上がる（100 点満点） */
export type SkillKey = 'debate' | 'english' | 'kanji' | 'vocabJa' | 'vocabEn'

export interface SkillState {
  values: Record<SkillKey, number>
  /** 上がった回数（勝った数、やりとりの数、クリアした数） */
  counts: Record<SkillKey, number>
}

// ───────── 音声認識 ─────────

/** turbo: 高精度（約 550MB）/ small: 軽量（約 180MB） */
export type SpeechModelId = 'turbo' | 'small'

export interface SpeechStatus {
  /** マイクの声を文字にできる状態か */
  ready: boolean
  /** エンジン本体が入っているか */
  engine: boolean
  /** 入っているモデル */
  installed: SpeechModelId[]
  /** 使うモデル */
  model: SpeechModelId
  /** 準備（ダウンロード）の途中経過 */
  progress: { label: string; received: number; total: number } | null
  error: string | null
}

// ───────── 英会話 ─────────

export interface EikaiwaSettings {
  /** 相手の英語を読み上げる */
  tts: boolean
  /** 英語のむずかしさを、授業の進み具合に合わせない（制限なし） */
  unlimited: boolean
  /** 日本語訳を表示する */
  showJa: boolean
}

export interface EikaiwaLevel {
  /** 画面に出す説明（「中学 1 年 英語 3「一般動詞」まで」など） */
  label: string
  unlimited: boolean
}

// ───────── 漢字特訓 ─────────

/** joyo: 常用漢字のみ / other: 常用外のみ / all: 全部 */
export type KanjiScope = 'joyo' | 'other' | 'all'

export interface KanjiSetup {
  /** learn: 習う順 / random: ランダム */
  order: 'learn' | 'random'
  scope: KanjiScope
  /** 範囲（まとまりの ID。小学 1 年 = g1 など）。空なら、対象のすべて */
  groups: string[]
}

/** その漢字を使う代表的な言葉と、例文（AI が用意する） */
export interface KanjiWords {
  words: { word: string; reading: string; meaning: string }[]
  sentences: string[]
}

export interface KanjiEntry {
  char: string
  /** 「小学 1 年」「中学以降」など */
  gradeLabel: string
  on: string[]
  kun: string[]
  /** 書き順どおりに並んだ線（SVG のパス。109 × 109 の枠） */
  strokes: string[]
}

export interface KanjiState {
  /** 特訓の途中か（偽なら準備の画面） */
  active: boolean
  setup: KanjiSetup
  /** いま練習している漢字 */
  entry: KanjiEntry | null
  /** 言葉と例文。用意できるまでは null */
  words: KanjiWords | null
  wordsBusy: boolean
  wordsError: string | null
  /** いまの漢字を、正しい書き順で書けた回数 */
  written: number
  /** これまでにクリアした字数 */
  cleared: number
  /** いまの条件に合う字の数と、そのうちクリアした数 */
  pool: { total: number; done: number }
}

// ───────── 語彙力特訓 ─────────

/** ja: 日本語の言葉 / en: 英単語 */
export type VocabLang = 'ja' | 'en'

export interface VocabWord {
  id: string
  word: string
  /** 日本語: 読み（ひらがな）／ 英語: 発音の目安（カタカナ） */
  reading: string
  /** 品詞や種類 */
  pos: string
  meaning: string
  /** 例文。英語のときは translation に日本語訳が入る */
  examples: { text: string; translation: string }[]
}

/** ノートを AI が読んで確かめた結果 */
export interface VocabCheck {
  ok: boolean
  /** 言葉を正しく書けていた回数 */
  wordCount: number
  /** 読み取った例文と、その評価 */
  sentences: { text: string; ok: boolean; comment: string }[]
  feedback: string
  at: number
}

export interface VocabState {
  /** 特訓の途中か（偽なら準備の画面） */
  active: boolean
  lang: VocabLang
  levelId: string
  /** 例文の決まり。own: 自分で考える / copy: お手本を書き写してよい */
  sentenceMode: 'own' | 'copy'
  /** いま練習している言葉 */
  word: VocabWord | null
  /** いちばん最近のチェック */
  last: { word: VocabWord; check: VocabCheck } | null
  /** このレベルでクリアした数 */
  cleared: number
  busy: 'preparing' | 'checking' | null
  /** 練習用のノート */
  notebookId: string | null
}

// ───────── ディベート ─────────

/** pro: 肯定側 / con: 否定側 */
export type DebateSide = 'pro' | 'con'
/** 立論 / 反対尋問 / 反駁 / 最終弁論 */
export type DebatePhase = 'constructive' | 'cross' | 'rebuttal' | 'closing'

export interface DebateTurn {
  id: string
  phase: DebatePhase
  /** 反対尋問と反駁の何回目か（立論と最終弁論は 0） */
  round: number
  side: DebateSide
  speaker: 'user' | 'opponent'
  text: string
  at: number
}

export interface DebateVerdict {
  winner: DebateSide | 'draw'
  scores: Record<DebateSide, number>
  reasons: string
  /** ユーザーへの助言 */
  advice: string
}

export interface DebateSetup {
  topic: string
  side: DebateSide | 'random'
  opponentId: string
  /** 反対尋問 → 反駁 をくり返す回数（1〜3） */
  rounds: number
}

export interface DebateSession {
  id: string
  topic: string
  userSide: DebateSide
  opponentId: string
  rounds: number
  turns: DebateTurn[]
  /** 次に話す番。すべて終わっていれば null */
  next: { phase: DebatePhase; round: number; side: DebateSide } | null
  verdict: DebateVerdict | null
  startedAt: number
  finishedAt: number | null
}

// ───────── ウィンドウ ─────────

export interface ViewParams {
  lessonId?: string
  /** 小学校の授業で、学び直し向け（深掘り）の本文を開く */
  variant?: LessonVariant
  notebookId?: string
  characterId?: string
  /** 教科書で選択した文章を質問欄に引用する */
  quote?: string
  /** テストの結果を表示する */
  testResultId?: string
  /** ディベートの続きや結果を表示する */
  debateId?: string
  /** 用語集で、この用語を開く */
  term?: string
  /** 検索の画面で、この言葉を探す */
  query?: string
  /** ノートで、このページを開く（1 始まり） */
  page?: number
  /** 開く画面を、この側に固定する（教科書といっしょに開くノート。もう 1 つの画面は、反対側に並ぶ） */
  beside?: 'left' | 'right'
}

// ───────── 用語集・関連する授業・年表・検索 ─────────

/** 画面に出す、授業の情報 */
export interface LessonRef {
  lessonId: string
  variant: LessonVariant
  courseId: string
  courseTitle: string
  school: string
  subject: string
  number: string
  title: string
}

export interface GlossaryQuery {
  /** 探す言葉（用語・読み。inText が真なら、簡単な解説の中も探す） */
  query?: string
  school?: string
  /** 教科の種類（math、science など） */
  subject?: string
  /** 読みのはじめの行（「あ」「か」…） */
  initial?: string
  inText?: boolean
  offset?: number
  limit?: number
}

export interface GlossaryItem {
  term: string
  reading: string
  short: string
  /** その用語が出てくる授業の数 */
  count: number
  schools: string[]
}

export interface GlossaryList {
  /** 用語集のデータが用意されているか */
  ready: boolean
  total: number
  items: GlossaryItem[]
  updatedAt: number
}

/** 用語 1 つの、くわしい中身 */
export interface GlossaryEntry {
  term: string
  reading: string
  aliases: string[]
  /** その用語が出てくる授業の数（uses は、学ぶ順に先のものだけ） */
  total: number
  uses: (LessonRef & { short: string; detail: string })[]
}

/** その授業の、前提の授業と、関連する授業（via は、つながりのもとになった言葉） */
export interface LessonLinks {
  prerequisites: (LessonRef & { via: string })[]
  related: (LessonRef & { via: string })[]
}

export interface TimelineData {
  at: number
  /** lessons は、そのできごとが出てくる授業（保存名） */
  events: { year: number; yearLabel: string; label: string; note: string; region: 'japan' | 'world'; lessons: string[] }[]
  /** 保存名 → 授業の情報 */
  lessons: Record<string, { lessonId: string; variant: LessonVariant; courseTitle: string; number: string; title: string }>
}

export type SearchSource = 'textbook' | 'note' | 'memo' | 'glossary'

export interface SearchQuery {
  query: string
  /** 探す範囲 */
  sources: SearchSource[]
  /** 教科書を探す学校（空なら、すべて） */
  schools?: string[]
  /** 教科書を探す科目（指定すると、その科目だけ） */
  courseId?: string
}

export interface SearchHit {
  source: SearchSource
  title: string
  /** 科目の名前や、ページ番号 */
  where: string
  /** 前後を切り出した文（見つけた言葉の前後に、目印が入っている） */
  snippets: string[]
  count: number
  inTitle: boolean
  lessonId?: string
  variant?: LessonVariant
  notebookId?: string
  page?: number
  term?: string
}

export interface SearchResult {
  hits: SearchHit[]
  /** 範囲ごとの、見つかった数（表示しているのは、そのうちの先のもの） */
  totals: Partial<Record<SearchSource, number>>
}

/** ディベート中に先生へ相談した記録を、チャットの記録と同じ仕組みで保存するための目印 */
export const COACH_CHANNEL = '_debate'
/** 英会話の記録の置き場所 */
export const EIKAIWA_CHANNEL = '_eikaiwa'

export interface AiStatus {
  claude: boolean
  codex: boolean
  /** いまのつなぎ方（この PC のコマンドで動かしているときは、入らない） */
  route?: AiRoute
}

/**
 * AI へのつなぎ方（Windows 版）。
 * own-key = 利用者の API キー ／ siwc = Sign in with ChatGPT ／ relay = この PC の claude・codex のコマンド（開発用。配る版には出さない）
 */
export type AiRoute = 'own-key' | 'siwc' | 'relay'

/** 設定の画面に見せる、つなぎ方の様子（API キーそのものは、画面には渡さない） */
export interface AiLinkState {
  route: AiRoute
  /** 選べる方式 */
  routes: AiRoute[]
  anthropicKey: boolean
  openaiKey: boolean
  /** 仕事ごとに、モデルを自動で選ぶ */
  routing: boolean
  siwc: { signedIn: boolean; email: string; planUsage: boolean }
  /** Sign in with ChatGPT で使うモデル */
  siwcModel: string
}

export interface AiLinkPatch {
  route?: AiRoute
  anthropicKey?: string
  openaiKey?: string
  routing?: boolean
  siwcModel?: string
}
