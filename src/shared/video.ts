import { parsePicture } from './blocks.ts'
import { parseSim, simParams, type SimSpec } from './sims.ts'

/**
 * 授業の動画（試作）。
 *
 * 動画は、台本（場面の並び）と、せりふごとの読み上げ音声からできている。
 * 画面はアプリが台本から描くので（板書・本文の図・動く図解・挿絵・人物の顔・字幕）、AI が決めるのは
 * 「何を、どの順に、どの画面で話すか」だけ。動画ファイルにするときは、再生している画面をそのまま録画する。
 */

/** 場面の種類: 題・板書・本文の図・動く図解・挿絵 */
export type VideoKind = 'title' | 'board' | 'figure' | 'sim' | 'picture'
export const VIDEO_KINDS: VideoKind[] = ['title', 'board', 'figure', 'sim', 'picture']

export interface VideoLine {
  /** 話す人（登場人物の ID） */
  speaker: string
  expression: string
  /** 字幕に出す文（数式は $…$） */
  text: string
  /** 読み上げる文（記号や式を、声に出して読める形に書きかえたもの） */
  say: string
  /** 板書の項目を、何個目まで見せるか（このせりふが始まるときに出す） */
  show: number
  /** 動く図解の値（このせりふのあいだに、この値まで動かす） */
  set: Record<string, number>
}

export interface VideoScene {
  kind: VideoKind
  heading: string
  /** 板書の項目（board）。題の場面では、副題を 1 つ */
  items: string[]
  /** figure: 本文の何番目の図か（1 から）。picture: 挿絵の id */
  ref: string
  lines: VideoLine[]
}

export interface VideoScript {
  scenes: VideoScene[]
  /** 読み上げソフトの読みまちがいを、点検して直したか */
  checked?: boolean
}

/** 画面に渡す、動画ひとつぶんの情報 */
export interface VideoInfo {
  lessonId: string
  variant: 'standard' | 'deep'
  /** 「5-3 凸レンズのはたらきと像」のような題 */
  title: string
  courseTitle: string
  script: VideoScript
  /** 本文の図（```figure・```plot のブロック）。場面の ref で引く */
  figures: string[]
  /** 本文の動く図解（```sim の中身）。無ければ空文字 */
  sim: string
  /** せりふごとの音声の長さ（秒）。場面をまたいで、せりふの順に並ぶ。音声がまだ無ければ空 */
  durations: number[]
  /** 読み上げの声の名前（クレジット用） */
  voice: string
  /** 書き出した動画ファイルの場所（あれば） */
  file: string
}

/** 動画を作るときの進み具合 */
export interface VideoProgress {
  step: 'script' | 'reading' | 'voice' | 'done'
  done: number
  total: number
}

const fence = (kind: string) => new RegExp('```' + kind + '\\n([\\s\\S]*?)\\n```', 'g')

/** 本文の図（```figure と ```plot）を、出てくる順に、ブロックごと取り出す */
export function lessonFigures(body: string): string[] {
  const text = body.replace(/\r\n/g, '\n')
  return [...text.matchAll(/```(figure|plot)\n[\s\S]*?\n```/g)].map((m) => m[0])
}

/** 本文の挿絵（```picture）の id と説明 */
export function lessonPictures(body: string): { id: string; caption: string }[] {
  return [...body.replace(/\r\n/g, '\n').matchAll(fence('picture'))].map((m) => parsePicture(m[1])).filter((p): p is { id: string; caption: string } => !!p)
}

/** 本文の動く図解（```sim の中身）。無ければ空文字 */
export function lessonSim(body: string): string {
  return [...body.replace(/\r\n/g, '\n').matchAll(fence('sim'))][0]?.[1] ?? ''
}

/** 字幕の文から、読み上げ用の文を作る（台本に読み上げ用の文が無いときの予備） */
export function speakable(text: string): string {
  return text
    .replace(/\$([^$]*)\$/g, (_m, math: string) => math.replace(/\\[a-zA-Z]+/g, ' ').replace(/[{}^_\\]/g, ' '))
    .replace(/\*\*/g, '')
    .replace(/[「」『』（）()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 台本のせりふを、場面をまたいで順に並べる */
export function videoLines(script: VideoScript): { scene: number; line: number; data: VideoLine }[] {
  return script.scenes.flatMap((scene, s) => scene.lines.map((data, l) => ({ scene: s, line: l, data })))
}

export interface VideoCast {
  id: string
  expressions: string[]
  teacher: boolean
}

const str = (value: unknown, max: number) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * AI が返した台本を確かめて、決まった形に整える。決まりに合わないときは、わけを添えて投げる。
 * figures は本文の図の数、pictures は本文の挿絵の id、sim は本文の動く図解（無ければ null）。
 */
export function cleanVideoScript(raw: unknown, cast: VideoCast[], figures: number, pictures: string[], sim: SimSpec | null): VideoScript {
  const input = (raw as { scenes?: unknown })?.scenes
  if (!Array.isArray(input)) throw new Error('場面の並びがありません')
  if (input.length < 4 || input.length > 18) throw new Error(`場面の数が合いません（${input.length}）`)
  const params = sim ? simParams(sim) : {}
  const teacher = cast.find((c) => c.teacher)
  const scenes = input.map((value, index): VideoScene => {
    const scene = value as Record<string, unknown>
    const kind = VIDEO_KINDS.find((k) => k === scene['kind'])
    if (!kind) throw new Error(`場面 ${index + 1}: 種類が分かりません（${String(scene['kind'])}）`)
    let ref = str(scene['ref'], 80)
    if (kind === 'figure') {
      const n = Number(ref)
      if (!Number.isInteger(n) || n < 1 || n > figures) throw new Error(`場面 ${index + 1}: 本文に無い図を指しています（${ref}）`)
      ref = String(n)
    } else if (kind === 'picture') {
      if (!pictures.includes(ref)) throw new Error(`場面 ${index + 1}: 本文に無い挿絵を指しています（${ref}）`)
    } else if (kind === 'sim') {
      if (!sim) throw new Error(`場面 ${index + 1}: 本文に動く図解がありません`)
      ref = ''
    } else ref = ''
    const items = (Array.isArray(scene['items']) ? scene['items'] : []).map((item) => str(item, 70)).filter(Boolean).slice(0, kind === 'title' ? 1 : 6)
    const rawLines = Array.isArray(scene['lines']) ? scene['lines'] : []
    if (!rawLines.length || rawLines.length > 12) throw new Error(`場面 ${index + 1}: せりふの数が合いません（${rawLines.length}）`)
    let shown = 0
    const lines = rawLines.map((entry, at): VideoLine => {
      const line = entry as Record<string, unknown>
      const speaker = cast.find((c) => c.id === str(line['speaker'], 20))
      if (!speaker) throw new Error(`場面 ${index + 1}: 登場人物でない人が話しています（${str(line['speaker'], 20)}）`)
      const text = str(line['text'], 130)
      if (!text) throw new Error(`場面 ${index + 1}: 空のせりふがあります`)
      const expression = str(line['expression'], 20)
      // 板書は、前のせりふより減らさない（出したものは、その場面のあいだ出したままにする）
      shown = kind === 'board' ? Math.max(shown, Math.min(items.length, Math.max(0, Math.round(Number(line['show']) || 0)))) : 0
      const set: Record<string, number> = {}
      if (kind === 'sim') {
        for (const pair of Array.isArray(line['set']) ? line['set'] : []) {
          const { name, value } = pair as { name?: unknown; value?: unknown }
          const param = params[String(name)]
          if (param && Number.isFinite(Number(value))) set[String(name)] = Math.min(param.max, Math.max(param.min, Number(value)))
        }
      }
      return { speaker: speaker.id, expression: speaker.expressions.includes(expression) ? expression : '', text, say: str(line['say'], 260) || speakable(text), show: at === rawLines.length - 1 && kind === 'board' ? items.length : shown, set }
    })
    return { kind, heading: str(scene['heading'], 40), items, ref, lines }
  })
  const all = scenes.flatMap((scene) => scene.lines)
  if (all.length < 10 || all.length > 90) throw new Error(`せりふの数が合いません（${all.length}）`)
  if (teacher && all.filter((line) => line.speaker === teacher.id).length < all.length / 2) throw new Error('先生のせりふが少なすぎます')
  // 同級生がいるのに、先生がひとりで話しつづける台本は使わない（見ている人の代わりに、疑問を言う役が要る）
  if (teacher && cast.length > 1 && all.filter((line) => line.speaker !== teacher.id).length < all.length * 0.15) throw new Error('同級生のせりふが少なすぎます（全体の 2〜3 割を、同級生の疑問や言い直しにします）')
  return { scenes }
}

/** 動く図解の場面で、その時点までに決まっている値（はじめの値に、せりふごとの set を順に重ねたもの） */
export function simValuesAt(script: VideoScript, sim: SimSpec, scene: number, line: number): Record<string, number> {
  const values = { ...sim.values }
  script.scenes.forEach((s, si) => {
    if (s.kind !== 'sim' || si > scene) return
    s.lines.forEach((l, li) => {
      if (si < scene || li <= line) Object.assign(values, l.set)
    })
  })
  return values
}

// ───────── 読みをくらべる（読み上げソフトの読みまちがいを見つけるため） ─────────

const O_ROW = 'オコソトノホモヨロゴゾドボポョォ'
const E_ROW = 'エケセテネヘメレゲゼデベペェ'
const VOWELS: [string, string][] = [
  ['ア', 'アカサタナハマヤラワガザダバパャァ'],
  ['イ', 'イキシチニヒミリギジヂビピィ'],
  ['ウ', 'ウクスツヌフムユルグズヅブプュゥヴ'],
  ['エ', E_ROW],
  ['オ', O_ROW],
]

/** 読み（カタカナ）を、書き方のゆれ（のばす音・助詞・区切り）をならした形にする。くらべるためだけに使う */
export function soundKey(reading: string): string {
  const kana = reading
    .normalize('NFKC')
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[^ァ-ヶー]/g, '')
    .replace(/ヲ/g, 'オ')
    .replace(/ヅ/g, 'ズ')
    .replace(/ヂ/g, 'ジ')
    .replace(/ハ/g, 'ワ')
    .replace(/ヘ/g, 'エ')
  let out = ''
  for (const ch of kana) {
    const prev = out[out.length - 1] ?? ''
    if (ch === 'ウ' && O_ROW.includes(prev)) out += 'オ'
    else if (ch === 'イ' && E_ROW.includes(prev)) out += 'エ'
    else if (ch === 'ー') out += VOWELS.find(([, row]) => row.includes(prev))?.[0] ?? ''
    else out += ch
  }
  return out
}

/** 2 つの読みが、何文字ぶんちがうか */
export function soundDistance(a: string, b: string): number {
  const x = soundKey(a)
  const y = soundKey(b)
  let row = Array.from({ length: y.length + 1 }, (_v, i) => i)
  for (let i = 1; i <= x.length; i++) {
    const next = [i]
    for (let j = 1; j <= y.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
    row = next
  }
  return row[y.length]
}

export { parseSim }
