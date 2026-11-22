import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { KANJI_GROUPS, groupOfGrade, groupsInScope } from '@shared/kanji'
import type { KanjiEntry, KanjiSetup, KanjiState, KanjiWords } from '@shared/types'
import { askStructured } from './ai/ask'
import { resourcesDir } from './paths'
import { raiseSkill } from './skills'
import { JsonState, dataFile, getSettings } from './store'
import { getLang, t } from '@shared/i18n'

/**
 * 漢字特訓モード。
 *
 *   1 つ目のウィンドウ … 漢字、読み、代表的な単語、例文
 *   2 つ目のウィンドウ … 書き順のアニメーション
 *   3 つ目のウィンドウ … 書きこむノート（正しい書き順で 10 回書き、単語と例文を書き写す）
 *
 * 書き順・読み・学年は、同梱のデータ（resources/kanji。KanjiVG と KANJIDIC2 から作成）を使う。
 * 単語と例文は、AI が 10 字ぶんずつまとめて用意し、ためておく。書き順の判定に AI は使わない。
 */

// ───────── 同梱のデータ ─────────

interface Raw {
  /** 学年（1〜6 = 小学校、8 = そのほかの常用漢字、9・10 = 人名用漢字、0 = それ以外） */
  g: number
  /** 新聞でよく使われる順位（無ければ 0） */
  f: number
  on: string[]
  kun: string[]
  /** 書き順どおりに並んだ線 */
  d: string[]
}

let table: Record<string, Raw> | null = null
let ordered: string[] | null = null

function kanjiTable(): Record<string, Raw> {
  table ??= (JSON.parse(gunzipSync(readFileSync(join(resourcesDir('kanji'), 'kanji.json.gz'))).toString('utf8')) as { kanji: Record<string, Raw> }).kanji
  return table
}

const toKatakana = (text: string) => text.replace(/[.\-]/g, '').replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))

/**
 * 習う順。小学 1 年 → … → 小学 6 年 → 中学以降 → 人名用漢字 → そのほか。
 * 学年の中は、学年別漢字配当表と同じく、音読み（無ければ訓読み）の五十音順。
 * 常用外は、よく使われる順。
 */
function learnOrder(): string[] {
  if (ordered) return ordered
  const table = kanjiTable()
  const rank = new Map<string, number>(KANJI_GROUPS.map((g, i) => [g.id, i]))
  const info = new Map(
    Object.entries(table).map(([char, e]) => {
      const group = groupOfGrade(e.g)
      return [char, { group: rank.get(group) ?? 99, joyo: e.g >= 1 && e.g <= 8, key: e.on[0] ?? toKatakana(e.kun[0] ?? ''), freq: e.f || 99999 }]
    }),
  )
  ordered = Object.keys(table).sort((a, b) => {
    const x = info.get(a)!
    const y = info.get(b)!
    if (x.group !== y.group) return x.group - y.group
    if (!x.joyo && x.freq !== y.freq) return x.freq - y.freq
    return (x.joyo ? x.key.localeCompare(y.key, 'ja') : 0) || a.codePointAt(0)! - b.codePointAt(0)!
  })
  return ordered
}

const GROUP_LABEL = new Map<string, string>(KANJI_GROUPS.map((g) => [g.id, g.label]))

function entryOf(char: string | null): KanjiEntry | null {
  const raw = char ? kanjiTable()[char] : null
  if (!char || !raw) return null
  return { char, gradeLabel: GROUP_LABEL.get(groupOfGrade(raw.g)) ?? '', on: raw.on, kun: raw.kun, strokes: raw.d }
}

// ───────── 状態 ─────────

interface Stored {
  active: boolean
  setup: KanjiSetup
  char: string | null
  /** このあと出す字（単語と例文を先に用意しておくため、少し先まで決めておく） */
  queue: string[]
  cleared: string[]
  /** とばした字（ほかの字が終わってから、もう一度出す） */
  skipped: string[]
}

const DEFAULT_SETUP: KanjiSetup = { order: 'learn', scope: 'joyo', groups: [] }
const stored = new JsonState<Stored>(() => dataFile('kanji', 'state.json'), () => ({ active: false, setup: DEFAULT_SETUP, char: null, queue: [], cleared: [], skipped: [] }))
// 言葉の意味は表示の言語で書かせるので、日本語以外のときは、言語ごとのファイルにためる
const wordCache = new JsonState<Record<string, KanjiWords>>(() => dataFile('kanji', getLang() === 'ja' ? 'words.json' : `words.${getLang()}.json`), () => ({}))
/** いまの字を、正しい書き順で書けた回数（ノートの窓から届く） */
let written = 0
let wordsError: string | null = null

function cleanSetup(setup: KanjiSetup | undefined): KanjiSetup {
  const scope = setup?.scope === 'other' || setup?.scope === 'all' ? setup.scope : 'joyo'
  const allowed = new Set<string>(groupsInScope(scope).map((g) => g.id))
  return {
    order: setup?.order === 'random' ? 'random' : 'learn',
    scope,
    groups: (Array.isArray(setup?.groups) ? setup.groups : []).filter((id) => allowed.has(id)),
  }
}

/** 条件（対象と範囲）に合う字を、習う順に並べたもの */
function poolOf(setup: KanjiSetup): string[] {
  const table = kanjiTable()
  const groups = new Set<string>(setup.groups.length ? setup.groups : groupsInScope(setup.scope).map((g) => g.id))
  return learnOrder().filter((char) => groups.has(groupOfGrade(table[char].g)))
}

export function kanjiCount(setup: KanjiSetup): { total: number; done: number } {
  const pool = poolOf(cleanSetup(setup))
  const cleared = new Set(stored.get().cleared)
  return { total: pool.length, done: pool.filter((char) => cleared.has(char)).length }
}

/** このあと出す字を、8 字先まで決めておく */
function fillQueue(s: Stored): Stored {
  const pool = poolOf(s.setup)
  const cleared = new Set(s.cleared)
  const taken = new Set([...(s.char ? [s.char] : []), ...s.queue])
  const skipped = new Set(s.skipped)
  const open = pool.filter((char) => !cleared.has(char) && !taken.has(char))
  // とばした字は後ろへ。すべてクリア済みなら、復習としてもう一度出す
  let rest = [...open.filter((char) => !skipped.has(char)), ...open.filter((char) => skipped.has(char))]
  if (!rest.length && !taken.size) rest = [...pool]
  const queue = [...s.queue]
  while (queue.length < 8 && rest.length) {
    const at = s.setup.order === 'random' ? Math.floor(Math.random() * rest.length) : 0
    queue.push(rest.splice(at, 1)[0])
  }
  return { ...s, queue }
}

/** 次の字へ進む */
function advance(s: Stored): Stored {
  const filled = fillQueue({ ...s, char: null })
  const [char = null, ...queue] = filled.queue
  written = 0
  return fillQueue({ ...filled, char, queue })
}

export function kanjiState(): KanjiState {
  const s = stored.get()
  const entry = s.active ? entryOf(s.char) : null
  return {
    active: s.active,
    setup: s.setup,
    entry,
    words: (entry && wordCache.get()[entry.char]) || null,
    wordsBusy: !!generating,
    wordsError: entry && !wordCache.get()[entry.char] && !generating ? wordsError : null,
    written,
    cleared: s.cleared.length,
    pool: kanjiCount(s.setup),
  }
}

// ───────── 単語と例文（AI が用意する） ─────────

const WORDS_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kanji: { type: 'string' },
          words: {
            type: 'array',
            items: {
              type: 'object',
              properties: { word: { type: 'string' }, reading: { type: 'string' }, meaning: { type: 'string' } },
              required: ['word', 'reading', 'meaning'],
              additionalProperties: false,
            },
          },
          sentences: { type: 'array', items: { type: 'string' } },
        },
        required: ['kanji', 'words', 'sentences'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
}

let generating: Promise<void> | null = null

async function generate(chars: string[]): Promise<void> {
  const list = chars
    .map((char) => {
      const e = entryOf(char)!
      return t('- {0}（{1}。音: {2} ／ 訓: {3}）', char, e.gradeLabel, e.on.join('、') || t('なし'), e.kun.map((k) => k.replace(/[.\-]/g, '')).join('、') || t('なし'))
    })
    .join('\n')
  const output = await askStructured<{ items: { kanji: string; words: KanjiWords['words']; sentences: string[] }[] }>(
    getSettings().ai,
    t('あなたは、日本の学校で国語を教える教師で、漢字の教材を作る編集者です。'),
    t('次の漢字それぞれについて、漢字練習の教材を作ってください。\n\n# 漢字\n{0}\n\n# 各項目\n- kanji: その漢字 1 字\n- words: その漢字をふくむ、代表的でよく使う言葉を 3 つ。word に表記、reading に読み（ひらがな）、meaning に意味（やさしい言葉で短く）を書きます。音読みと訓読みの両方がよく使われる漢字では、両方の読みの言葉を入れます。\n- sentences: その漢字をふくむ、短く自然な例文を 2 つ。1 文は 12〜22 字ほどにします。\n\n# 決まり\n- 小学校で習う漢字では、その学年の子どもにわかる言葉と文にし、上の学年で習う漢字はなるべく使いません。\n- 常用漢字でない字や、使われることの少ない字では、実際に使われる言葉（人名・地名でもよい）を選び、作り話の言葉を書きません。言葉が 3 つ無いときは、ある分だけにします。\n- 例文は、書き写す練習に使います。正しい表記と送りがなで書きます。', list),
    WORDS_SCHEMA,
  )
  const wanted = new Set(chars)
  const next = { ...wordCache.get() }
  for (const item of output.items ?? []) {
    const char = String(item?.kanji ?? '').trim()
    if (!wanted.has(char)) continue
    const words = (Array.isArray(item.words) ? item.words : [])
      .map((w) => ({ word: String(w?.word ?? '').trim().slice(0, 30), reading: String(w?.reading ?? '').trim().slice(0, 40), meaning: String(w?.meaning ?? '').trim().slice(0, 120) }))
      .filter((w) => w.word.includes(char))
      .slice(0, 4)
    const sentences = (Array.isArray(item.sentences) ? item.sentences : [])
      .map((s) => String(s ?? '').trim().slice(0, 80))
      .filter((s) => s.includes(char))
      .slice(0, 3)
    if (words.length || sentences.length) next[char] = { words, sentences }
  }
  wordCache.set(next)
}

/** いまの字と、このあと出す字のうち、単語と例文がまだ無いものを AI に用意してもらう（裏で進める） */
function ensureWords(notify: () => void): void {
  const s = stored.get()
  if (!s.active || !s.char || generating) return
  const have = wordCache.get()
  const missing = [s.char, ...s.queue].filter((char) => !have[char])
  // いまの字のぶんがあり、先の字も 3 字ぶん以上そろっていれば、まだ頼まない
  if (!missing.length || (have[s.char] && missing.length <= s.queue.length - 3)) return
  const asked = missing.slice(0, 10)
  wordsError = null
  generating = generate(asked)
    .then(() => {
      // AI が返さなかった字は、空の教材を入れて、同じ字を何度も頼まないようにする
      const now = { ...wordCache.get() }
      let changed = false
      for (const char of asked) {
        if (!now[char]) {
          now[char] = { words: [], sentences: [] }
          changed = true
        }
      }
      if (changed) wordCache.set(now)
    })
    .catch((error: unknown) => {
      wordsError = error instanceof Error ? error.message : String(error)
    })
    .finally(() => {
      generating = null
      notify()
    })
  notify()
}

/** 用意に失敗したあと、もう一度頼む */
export function retryKanjiWords(notify: () => void): KanjiState {
  ensureWords(notify)
  return kanjiState()
}

// ───────── 進行 ─────────

export function startKanji(setup: KanjiSetup, notify: () => void): KanjiState {
  const clean = cleanSetup(setup)
  if (!poolOf(clean).length) throw new Error(t('その条件に合う漢字がありません。'))
  const previous = stored.get()
  // 同じ条件の続きなら、前の字から再開する
  const same = JSON.stringify(previous.setup) === JSON.stringify(clean) && previous.char && !previous.cleared.includes(previous.char)
  const base: Stored = same ? { ...previous, active: true } : { ...previous, active: true, setup: clean, char: null, queue: [] }
  if (!same) written = 0
  stored.set(base.char ? fillQueue(base) : advance(base))
  ensureWords(notify)
  return kanjiState()
}

export function stopKanji(): KanjiState {
  stored.update((s) => ({ ...s, active: false }))
  return kanjiState()
}

/** ノートの窓から: 正しい書き順で書けた回数 */
export function reportKanjiWritten(count: number): void {
  written = Math.max(0, Math.min(99, Math.round(Number(count) || 0)))
}

/** 1 字クリア。漢字力を上げて、次の字へ */
export function clearKanji(notify: () => void): KanjiState {
  const s = stored.get()
  if (!s.active || !s.char) throw new Error(t('漢字特訓を始めてから操作してください。'))
  const char = s.char
  raiseSkill('kanji')
  stored.set(advance({ ...s, cleared: [...s.cleared.filter((c) => c !== char), char], skipped: s.skipped.filter((c) => c !== char) }))
  ensureWords(notify)
  return kanjiState()
}

export function skipKanji(notify: () => void): KanjiState {
  const s = stored.get()
  if (!s.active || !s.char) throw new Error(t('漢字特訓を始めてから操作してください。'))
  const char = s.char
  stored.set(advance({ ...s, skipped: [...s.skipped.filter((c) => c !== char), char] }))
  ensureWords(notify)
  return kanjiState()
}
