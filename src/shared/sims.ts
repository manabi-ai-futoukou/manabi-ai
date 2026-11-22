/**
 * 教科書の本文に埋めこむ「動く図解」（```sim）の決まり。
 * 読む人がスライダーなどで条件を変えると、図と数値が計算しなおされる。
 * 図の中身はアプリが式から描くので、AI が決めるのは「どの図解を、どの値から始め、何を確かめさせるか」だけ。
 *
 *   ```sim
 *   {"kind": "pendulum", "values": {"length": 50, "angle": 20, "mass": 50}, "task": "ふりこの長さを変えると、1 往復の時間はどうなるでしょうか。"}
 *   ```
 *
 * 画面の描画（components/Sim.tsx）、AI への指示（main/ai/authoring.ts）、教材の検査（scripts/check-lessons.mjs）から使う。
 */
// 確認用の道具（Node がそのまま読みこむ）からも使えるよう、拡張子まで書く
import { compileExpression } from './figures.ts'
import { t } from './i18n.ts'

export interface SimParam {
  label: string
  unit: string
  min: number
  max: number
  step: number
  /** はじめの値（AI が決めなかったとき） */
  value: number
  /** 選ぶ項目がこの値のときだけ使う量（例: 抵抗 R₂ は、抵抗が 2 つのつなぎ方のときだけ） */
  when?: { choice: string; values: string[] }
}

export interface SimChoice {
  label: string
  options: Record<string, string>
}

export interface SimKind {
  /** 画面に出す名前 */
  title: string
  /** AI への説明: 何を確かめられる図解か、どんな授業に合うか */
  describe: string
  /** 合う教科（科目の「書き方の指示の名前」）と学校。当てはまらない科目では、AI に選ばせない */
  subjects: string[]
  schools: string[]
  params: Record<string, SimParam>
  choices?: Record<string, SimChoice>
}

const p = (label: string, unit: string, min: number, max: number, step: number, value: number): SimParam => ({ label, unit, min, max, step, value })

export const SIMS: Record<string, SimKind> = {
  // ───── 算数・数学 ─────
  fraction: {
    title: t('分数の大きさくらべ'),
    describe: t('2 つの分数をテープの図で表し、大きさをくらべる。分母をそろえた形（通分）も表示する。分数の意味、大きさくらべ、等しい分数、通分の授業に合う。'),
    subjects: ['math'],
    schools: ['es'],
    params: {
      n1: p(t('左の分子'), '', 0, 12, 1, 1),
      d1: p(t('左の分母'), '', 1, 12, 1, 2),
      n2: p(t('右の分子'), '', 0, 12, 1, 2),
      d2: p(t('右の分母'), '', 1, 12, 1, 4),
    },
  },
  graph: {
    title: t('グラフを動かす'),
    describe:
      t('式の中の文字（a、b、c、k、p、q）の値をスライダーで変えると、グラフがどう変わるかを確かめる。比例・反比例、一次関数、二次関数、三角関数、指数関数・対数関数など、「式の係数とグラフの形・位置の関係」を学ぶ授業に合う。'),
    subjects: ['math', 'risu'],
    schools: ['jhs', 'hs', 'hsp'],
    params: {},
  },
  dice: {
    title: t('確率の実験'),
    describe: t('コインやさいころを何回も投げて、あることがらが起こった割合（相対度数）が、回数を増やすと一定の値（確率）に近づくようすを確かめる。確率の意味、相対度数と確率、大数の法則の授業に合う。'),
    subjects: ['math', 'risu'],
    schools: ['jhs', 'hs', 'hsp'],
    params: {},
    choices: {
      event: { label: t('調べることがら'), options: { coin: t('コインを投げて表が出る'), one: t('さいころを投げて 1 の目が出る'), even: t('さいころを投げて偶数の目が出る'), seven: t('2 個のさいころを投げて目の和が 7 になる') } },
    },
  },
  unitcircle: {
    title: t('単位円と三角比'),
    describe: t('角 θ を変えると、単位円の上の点の座標と、sin θ・cos θ・tan θ の値がどう変わるかを確かめる。三角比の拡張（鈍角）、三角関数の定義、三角関数の値の符号や相互関係の授業に合う。'),
    subjects: ['math', 'risu'],
    schools: ['hs', 'hsp'],
    params: { angle: p(t('角 θ'), '°', 0, 360, 5, 30) },
  },
  // ───── 理科 ─────
  pendulum: {
    title: t('ふりこの動き'),
    describe: t('ふりこの長さ・ふれはば・おもりの重さを変えて、1 往復する時間（周期）を調べる。周期は長さだけで決まり、ふれはばや重さでは変わらない（ふれはばが小さいとき）。小学校のふりこのきまり、高校の単振り子の授業に合う。'),
    subjects: ['science'],
    schools: ['es', 'hs', 'hsp'],
    params: {
      length: p(t('ふりこの長さ'), 'cm', 20, 150, 5, 50),
      angle: p(t('ふれはば'), '°', 5, 30, 5, 20),
      mass: p(t('おもりの重さ'), 'g', 20, 200, 10, 50),
    },
  },
  lever: {
    title: t('てこのつり合い'),
    describe: t('左右のうでの、おもりの重さと支点からのきょり（うでの目もり 1〜6）を変えて、てこがどちらにかたむくかを調べる。「おもりの重さ × 支点からのきょり」が左右で等しいとつり合う。小学校のてこのきまりの授業に合う。'),
    subjects: ['science'],
    schools: ['es'],
    params: {
      leftWeight: p(t('左のおもりの重さ'), 'g', 10, 60, 10, 30),
      leftArm: p(t('左のきょり'), '', 1, 6, 1, 4),
      rightWeight: p(t('右のおもりの重さ'), 'g', 10, 60, 10, 20),
      rightArm: p(t('右のきょり'), '', 1, 6, 1, 6),
    },
  },
  spring: {
    title: t('ばねののび'),
    describe: t('ばねにつるすおもり（1 個 0.2 N）の数を変えて、ばねを引く力とばねののびの関係（比例。フックの法則）を調べる。力の大きさとばねののび、フックの法則の授業に合う。'),
    subjects: ['science'],
    schools: ['jhs', 'hs', 'hsp'],
    params: {
      weights: p(t('おもりの数'), t('個'), 0, 10, 1, 3),
      stretch: p(t('1 N あたりののび'), 'cm', 2, 10, 1, 5),
    },
  },
  circuit: {
    title: t('回路と電流・電圧'),
    describe:
      t('電源の電圧と抵抗の大きさを変えて、回路の各部分の電流と電圧を調べる。抵抗が 1 つの回路（オームの法則。wiring は single）と、2 つの抵抗の直列回路・並列回路（series・parallel）を切りかえられる。オームの法則、直列回路・並列回路の電流と電圧、合成抵抗の授業に合う。'),
    subjects: ['science'],
    schools: ['jhs', 'hs', 'hsp'],
    params: {
      voltage: p(t('電源の電圧'), 'V', 1.5, 12, 1.5, 6),
      r1: p(t('抵抗 R₁'), 'Ω', 5, 50, 5, 10),
      r2: { ...p(t('抵抗 R₂'), 'Ω', 5, 50, 5, 20), when: { choice: 'wiring', values: ['series', 'parallel'] } },
    },
    choices: { wiring: { label: t('つなぎ方'), options: { series: t('直列（抵抗 2 つ）'), parallel: t('並列（抵抗 2 つ）'), single: t('抵抗 1 つ') } } },
  },
  lens: {
    title: t('凸レンズと像'),
    describe: t('物体を凸レンズに近づけたり遠ざけたりして（distance は、レンズから物体までの距離）、できる像の位置・大きさ・向き（実像か虚像か）を、光の道すじの作図で調べる。凸レンズのはたらき、実像と虚像、レンズの式の授業に合う。'),
    subjects: ['science'],
    schools: ['jhs', 'hs', 'hsp'],
    params: {
      focal: p(t('焦点距離'), 'cm', 5, 20, 1, 10),
      distance: p(t('物体までの距離'), 'cm', 3, 60, 1, 30),
    },
  },
  moon: {
    title: t('月の満ち欠け'),
    describe: t('月が地球のまわりを回る位置（position は、新月の位置から回った角度。90 が上弦、180 が満月、270 が下弦）を変えて、地球から見た月の形がどう変わるかを調べる。月の形の変化と太陽との位置関係、月の満ち欠けの授業に合う。'),
    subjects: ['science'],
    schools: ['es', 'jhs', 'hs', 'hsp'],
    params: { position: p(t('月の位置'), '°', 0, 345, 15, 90) },
  },
}

/** graph で使える文字（係数）。x は変数 */
export const GRAPH_LETTERS = ['a', 'b', 'c', 'k', 'p', 'q']
const GRAPH_WORDS = new Set(['x', 'pi', 'e', 'sqrt', 'abs', 'sin', 'cos', 'tan', 'log', 'exp'])
const GRAPH_PARAM: SimParam = p('', '', -5, 5, 0.5, 1)

export interface SimSpec {
  kind: string
  values: Record<string, number>
  choices: Record<string, string>
  /** 読む人への課題（「〜を変えると、どうなるでしょうか」） */
  task: string
  /** graph のときだけ: 式（x と、a・b・c・k・p・q を使う）、表示用の式（LaTeX）、表示する範囲 */
  expr?: string
  label?: string
  range?: { xMin: number; xMax: number; yMin: number; yMax: number }
}

const snap = (value: number, param: SimParam) => {
  const stepped = Math.round((Math.min(param.max, Math.max(param.min, value)) - param.min) / param.step) * param.step + param.min
  return Math.round(stepped * 1000) / 1000
}

/** graph の式で使われている文字（出てきた順） */
export function graphLetters(expr: string): string[] {
  const letters: string[] = []
  for (const word of expr.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (GRAPH_WORDS.has(word)) continue
    for (const ch of word) if (ch !== 'x' && GRAPH_LETTERS.includes(ch) && !letters.includes(ch)) letters.push(ch)
  }
  return letters
}

/**
 * graph の式に、文字の値を入れて、x から値を求める関数にする。
 * 「ax^2」のように文字と x が続いていても読めるよう、1 文字ずつに分けて、かっこ付きの数に置きかえる。
 */
export function compileGraph(expr: string, values: Record<string, number>): (x: number) => number {
  const filled = expr.replace(/[A-Za-z]+/g, (word) => {
    const lower = word.toLowerCase()
    if (GRAPH_WORDS.has(lower)) return lower
    return [...lower]
      .map((ch) => {
        if (ch === 'x') return '(x)'
        if (!GRAPH_LETTERS.includes(ch)) throw new Error(t('使えない文字です: {0}', ch))
        return `(${values[ch] ?? 1})`
      })
      .join('')
  })
  return compileExpression(filled)
}

/** この図解で動かせる量（graph は、式に出てくる文字） */
export function simParams(spec: Pick<SimSpec, 'kind' | 'expr'>): Record<string, SimParam> {
  if (spec.kind !== 'graph') return SIMS[spec.kind]?.params ?? {}
  return Object.fromEntries(graphLetters(spec.expr ?? '').map((letter) => [letter, { ...GRAPH_PARAM, label: letter }]))
}

/**
 * 図解の指定を確かめて、そのまま使える形にする。値は範囲の中に丸める。使えない指定は null。
 * raw は、```sim の中身を JSON として読んだもの。
 */
export function normalizeSim(raw: unknown): SimSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const kind = String(input['kind'] ?? '')
  const def = SIMS[kind]
  if (!def) return null
  const spec: SimSpec = { kind, values: {}, choices: {}, task: String(input['task'] ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) }

  if (kind === 'graph') {
    const expr = String(input['expr'] ?? '').trim()
    if (!expr || expr.length > 60 || !/x/i.test(expr)) return null
    const range = (input['range'] ?? {}) as Record<string, unknown>
    const num = (value: unknown, fallback: number) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : fallback)
    spec.expr = expr
    spec.range = { xMin: num(range['xMin'], -5), xMax: num(range['xMax'], 5), yMin: num(range['yMin'], -5), yMax: num(range['yMax'], 5) }
    if (spec.range.xMax - spec.range.xMin < 1 || spec.range.yMax - spec.range.yMin < 1 || Object.values(spec.range).some((v) => Math.abs(v) > 1000)) return null
    const label = String(input['label'] ?? '').trim()
    if (label && label.length <= 80 && !/[$`]/.test(label)) spec.label = label
  }

  const params = simParams(spec)
  if (kind === 'graph' && (Object.keys(params).length === 0 || Object.keys(params).length > 4)) return null
  const given = (input['values'] ?? {}) as Record<string, unknown>
  for (const [name, param] of Object.entries(params)) {
    const value = Number(given[name])
    spec.values[name] = snap(Number.isFinite(value) && given[name] !== null && given[name] !== '' ? value : param.value, param)
  }
  const chosen = (input['choices'] ?? {}) as Record<string, unknown>
  for (const [name, choice] of Object.entries(def.choices ?? {})) {
    const value = String(chosen[name] ?? '')
    spec.choices[name] = value in choice.options ? value : Object.keys(choice.options)[0]
  }
  if (kind === 'graph') {
    try {
      compileGraph(spec.expr!, spec.values)(1)
    } catch {
      return null
    }
  }
  return spec
}

export function parseSim(source: string): SimSpec | null {
  try {
    return normalizeSim(JSON.parse(source))
  } catch {
    return null
  }
}

export function formatSim(spec: SimSpec): string {
  const { kind, values, choices, task, expr, label, range } = spec
  const body = { kind, ...(expr ? { expr, ...(label ? { label } : {}), range } : {}), values, ...(Object.keys(choices).length ? { choices } : {}), task }
  return '```sim\n' + JSON.stringify(body) + '\n```'
}

/** その科目で選べる図解 */
export function simsFor(course: { school: string; guide: string }): string[] {
  const keys = course.guide.split('+')
  return Object.entries(SIMS)
    .filter(([, def]) => def.schools.includes(course.school) && def.subjects.some((s) => keys.includes(s)))
    .map(([kind]) => kind)
}

// ───── 図解の中で使う計算（画面と、検査の両方から使う） ─────

/** ふりこの周期（秒）。長さは cm。ふれはばが小さいときの式 T = 2π√(L/g) */
export const pendulumPeriod = (lengthCm: number) => 2 * Math.PI * Math.sqrt(lengthCm / 100 / 9.8)

/** 抵抗の回路（single: 抵抗 1 つ、series: 2 つを直列、parallel: 2 つを並列）。電流は A、電圧は V */
export function circuitValues(voltage: number, r1: number, r2: number, wiring: string) {
  if (wiring === 'single') return { total: voltage / r1, i1: voltage / r1, i2: 0, v1: voltage, v2: 0, resistance: r1 }
  if (wiring === 'parallel') {
    const i1 = voltage / r1
    const i2 = voltage / r2
    return { total: i1 + i2, i1, i2, v1: voltage, v2: voltage, resistance: (r1 * r2) / (r1 + r2) }
  }
  const total = voltage / (r1 + r2)
  return { total, i1: total, i2: total, v1: total * r1, v2: total * r2, resistance: r1 + r2 }
}

/** 凸レンズの像。距離は cm。image は、レンズから像までの距離（正: 反対側の実像、負: 同じ側の虚像）。焦点の上では像ができない */
export function lensImage(focal: number, distance: number): { kind: 'real' | 'virtual' | 'none'; image: number; scale: number } {
  if (Math.abs(distance - focal) < 1e-9) return { kind: 'none', image: Infinity, scale: Infinity }
  const image = (distance * focal) / (distance - focal)
  return { kind: image > 0 ? 'real' : 'virtual', image, scale: Math.abs(image) / distance }
}

/** 月の形の名前。position は、新月から回った角度（°） */
export function moonName(position: number): string {
  const a = ((position % 360) + 360) % 360
  if (a < 8 || a > 352) return t('新月')
  if (a < 82) return t('三日月のころ（右側が細く光る）')
  if (a <= 98) return t('上弦の月（右半分が光る半月）')
  if (a < 172) return t('満月に近づく月（右側が大きく光る）')
  if (a <= 188) return t('満月')
  if (a < 262) return t('満月をすぎた月（左側が大きく光る）')
  if (a <= 278) return t('下弦の月（左半分が光る半月）')
  return t('新月に近づく月（左側が細く光る）')
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a))
/** 最小公倍数（分数の通分に使う） */
export const lcm = (a: number, b: number) => (a && b ? Math.abs(a * b) / gcd(a, b) : 0)

/** 確率の実験で調べることがらの、確率と、1 回ぶんの試行 */
export const DICE_EVENTS: Record<string, { probability: number; text: string; trial: (random: () => number) => boolean }> = {
  coin: { probability: 1 / 2, text: '1/2', trial: (r) => r() < 0.5 },
  one: { probability: 1 / 6, text: '1/6', trial: (r) => Math.floor(r() * 6) === 0 },
  even: { probability: 1 / 2, text: '1/2', trial: (r) => Math.floor(r() * 6) % 2 === 1 },
  seven: { probability: 1 / 6, text: '1/6', trial: (r) => Math.floor(r() * 6) + Math.floor(r() * 6) + 2 === 7 },
}
