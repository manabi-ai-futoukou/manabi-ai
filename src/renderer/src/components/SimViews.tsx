import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { DICE_EVENTS, circuitValues, compileGraph, lcm, lensImage, moonName, pendulumPeriod, type SimSpec } from '@shared/sims'
import { t, tx } from '@/lib/i18n'

/**
 * 動く図解の中身。どれも、渡された値から式で計算して描く（AI が描いた図ではない）。
 * 値を変える操作（スライダーなど）は、外わくの Sim が受け持つ。
 */

export interface SimViewProps {
  spec: SimSpec
  values: Record<string, number>
  choices: Record<string, string>
  /** 数式や太字をふくむ文を描く関数 */
  render: (text: string) => ReactNode
}

const INK = '#2c2a35'
const MUTED = '#5c596b'
const GRID = '#e2e6ea'
const BLUE = '#0e86a0'
const RED = '#d2553f'
const GREEN = '#3d9467'
const YELLOW = '#f6c544'

const minus = (text: string | number) => String(text).replace(/-/g, '−')
/** 小数第 digits 位までに丸めて、余分な 0 を取る */
const fixed = (value: number, digits = 2) => minus(Number(value.toFixed(digits)))

// ───────── 分数の大きさくらべ ─────────

function Frac({ n, d }: { n: number; d: number }) {
  return (
    <span className="frac" role="img" aria-label={t('{0} 分の {1}', d, n)}>
      <span>{n}</span>
      <span>{d}</span>
    </span>
  )
}

function FractionView({ values }: SimViewProps) {
  const rows = [
    { n: values['n1'], d: values['d1'], color: BLUE, y: 18 },
    { n: values['n2'], d: values['d2'], color: RED, y: 96 },
  ]
  const gap = 10
  const left = 20
  const [a, b] = rows
  // 1 より大きい分数は、テープを 3 本まで並べる。テープ 1 本の長さは、本数に合わせる
  const barsOf = (row: { n: number; d: number }) => Math.min(3, Math.max(1, Math.ceil(row.n / row.d)))
  const barWidth = (480 - gap * (Math.max(barsOf(a), barsOf(b)) - 1)) / Math.max(barsOf(a), barsOf(b))
  const common = lcm(a.d, b.d)
  const sign = a.n * b.d === b.n * a.d ? '＝' : a.n * b.d > b.n * a.d ? '＞' : '＜'
  return (
    <>
      <svg viewBox="0 0 520 170" role="img" aria-label={t('2 つの分数を表すテープの図')}>
        {rows.map((row, r) => {
          const bars = barsOf(row)
          return (
            <g key={r}>
              {Array.from({ length: bars }, (_, bar) => {
                const x = left + bar * (barWidth + gap)
                const filled = Math.max(0, Math.min(row.d, row.n - bar * row.d))
                return (
                  <g key={bar}>
                    <rect x={x} y={row.y} width={(barWidth * filled) / row.d} height="46" fill={row.color} opacity="0.75" />
                    {Array.from({ length: row.d - 1 }, (_, i) => (
                      <line key={i} x1={x + (barWidth * (i + 1)) / row.d} x2={x + (barWidth * (i + 1)) / row.d} y1={row.y} y2={row.y + 46} stroke={INK} strokeWidth="1" />
                    ))}
                    <rect x={x} y={row.y} width={barWidth} height="46" fill="none" stroke={INK} strokeWidth="2" />
                    <text x={x + barWidth / 2} y={row.y + 62} fontSize="11" textAnchor="middle" fill={MUTED}>
                      1
                    </text>
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
      <div className="sim-readout">
        <p className="sim-big">
          <Frac n={a.n} d={a.d} /> {sign} <Frac n={b.n} d={b.d} />
        </p>
        {a.d !== b.d && (
          <p>{tx('分母を {0} にそろえると、', common)}<Frac n={(a.n * common) / a.d} d={common} />{' '}{t('と')}{' '}<Frac n={(b.n * common) / b.d} d={common} />{' '}{t('です。')}</p>
        )}
        {(a.n > a.d * 3 || b.n > b.d * 3) && <p className="muted">{t('（テープの図は、3 本ぶんまで表示しています）')}</p>}
      </div>
    </>
  )
}

// ───────── グラフを動かす ─────────

/** 目もりの間かく（1・2・5 の倍数から、10 本前後になるもの） */
function tickStep(span: number): number {
  const rough = span / 10
  const base = Math.pow(10, Math.floor(Math.log10(rough)))
  return [1, 2, 5, 10].map((m) => m * base).find((s) => s >= rough) ?? base * 10
}

function GraphView({ spec, values, render }: SimViewProps) {
  const clipId = useId()
  const range = spec.range!
  const size = 360
  const pad = 30
  const sx = (x: number) => pad + ((x - range.xMin) / (range.xMax - range.xMin)) * (size - pad * 2)
  const sy = (y: number) => size - pad - ((y - range.yMin) / (range.yMax - range.yMin)) * (size - pad * 2)
  const ticks = (min: number, max: number) => {
    const step = tickStep(max - min)
    const list: number[] = []
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) list.push(Math.round(v / step) * step)
    return list
  }
  const axisX = sx(Math.max(range.xMin, Math.min(range.xMax, 0)))
  const axisY = sy(Math.max(range.yMin, Math.min(range.yMax, 0)))
  /** 曲線を折れ線で近似する。値が無い所や、急に飛ぶ所（反比例の x = 0 など）では線を切る */
  const pathOf = (letters: Record<string, number>) => {
    let fn: (x: number) => number
    try {
      fn = compileGraph(spec.expr!, letters)
    } catch {
      return ''
    }
    const span = range.yMax - range.yMin
    let d = ''
    let previous: number | null = null
    for (let i = 0; i <= 300; i++) {
      const x = range.xMin + ((range.xMax - range.xMin) * i) / 300
      const y = fn(x)
      if (!Number.isFinite(y) || y > range.yMax + span * 3 || y < range.yMin - span * 3) {
        previous = null
        continue
      }
      const jump = previous !== null && Math.abs(y - previous) > span * 2
      d += `${previous === null || jump ? 'M' : 'L'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`
      previous = y
    }
    return d
  }
  const moved = Object.keys(values).some((name) => values[name] !== spec.values[name])
  return (
    <>
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={t('式のグラフ')} className="sim-square">
        <defs>
          <clipPath id={clipId}>
            <rect x={pad} y={pad} width={size - pad * 2} height={size - pad * 2} />
          </clipPath>
        </defs>
        {ticks(range.xMin, range.xMax).map((v) => (
          <g key={`x${v}`}>
            <line x1={sx(v)} x2={sx(v)} y1={pad} y2={size - pad} stroke={GRID} />
            {v !== 0 && (
              <text x={sx(v)} y={axisY + 15} fontSize="10.5" textAnchor="middle" fill={MUTED}>
                {minus(v)}
              </text>
            )}
          </g>
        ))}
        {ticks(range.yMin, range.yMax).map((v) => (
          <g key={`y${v}`}>
            <line x1={pad} x2={size - pad} y1={sy(v)} y2={sy(v)} stroke={GRID} />
            {v !== 0 && (
              <text x={axisX - 6} y={sy(v) + 4} fontSize="10.5" textAnchor="end" fill={MUTED}>
                {minus(v)}
              </text>
            )}
          </g>
        ))}
        <line x1={pad - 6} x2={size - pad + 10} y1={axisY} y2={axisY} stroke={INK} strokeWidth="1.5" />
        <line x1={axisX} x2={axisX} y1={size - pad + 6} y2={pad - 10} stroke={INK} strokeWidth="1.5" />
        <text x={size - pad + 14} y={axisY + 4} fontSize="13" fontStyle="italic" fill={INK}>
          x
        </text>
        <text x={axisX} y={pad - 14} fontSize="13" fontStyle="italic" textAnchor="middle" fill={INK}>
          y
        </text>
        <text x={axisX - 6} y={axisY + 14} fontSize="10.5" textAnchor="end" fill={MUTED}>
          O
        </text>
        <g clipPath={`url(#${clipId})`}>
          {/* はじめのグラフを、うすい点線で残しておく（動かす前とくらべられるように） */}
          {moved && <path d={pathOf(spec.values)} fill="none" stroke="#9aa0a8" strokeWidth="1.5" strokeDasharray="5 4" />}
          <path d={pathOf(values)} fill="none" stroke={BLUE} strokeWidth="2.5" strokeLinejoin="round" />
        </g>
      </svg>
      <div className="sim-readout">
        {spec.label && <div className="sim-big">{render(`$${spec.label}$`)}</div>}
        <p>
          {Object.entries(values)
            .map(([name, value]) => `${name} = ${fixed(value, 1)}`)
            .join('、')}
        </p>
        {moved && <p className="muted">{t('点線は、動かす前のグラフです。')}</p>}
      </div>
    </>
  )
}

// ───────── 確率の実験 ─────────

function DiceView({ choices }: SimViewProps) {
  const event = DICE_EVENTS[choices['event']] ?? DICE_EVENTS['coin']
  const [run, setRun] = useState<{ trials: number; hits: number; points: [number, number][] }>({ trials: 0, hits: 0, points: [] })
  // 調べることがらを変えたら、はじめからやり直す
  useEffect(() => setRun({ trials: 0, hits: 0, points: [] }), [choices['event']])

  const add = (count: number) =>
    setRun((current) => {
      let { trials, hits } = current
      const points = [...current.points]
      const every = Math.max(1, Math.round(count / 40))
      for (let i = 1; i <= count; i++) {
        trials += 1
        if (event.trial(Math.random)) hits += 1
        if (i % every === 0 || i === count) points.push([trials, hits / trials])
      }
      return { trials, hits, points: points.length > 500 ? points.filter((_, i) => i % 2 === 1 || i === points.length - 1) : points }
    })

  const width = 520
  const height = 230
  const pad = { left: 44, right: 16, top: 14, bottom: 30 }
  const xMax = Math.max(100, run.trials)
  const sx = (n: number) => pad.left + (n / xMax) * (width - pad.left - pad.right)
  const sy = (ratio: number) => height - pad.bottom - ratio * (height - pad.top - pad.bottom)
  return (
    <>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('投げた回数と、起こった割合のグラフ')}>
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line x1={pad.left} x2={width - pad.right} y1={sy(v)} y2={sy(v)} stroke={GRID} />
            <text x={pad.left - 6} y={sy(v) + 4} fontSize="10.5" textAnchor="end" fill={MUTED}>
              {v}
            </text>
          </g>
        ))}
        <line x1={pad.left} x2={width - pad.right} y1={sy(event.probability)} y2={sy(event.probability)} stroke={RED} strokeWidth="1.5" strokeDasharray="6 4" />
        <text x={width - pad.right - 4} y={sy(event.probability) - 6} fontSize="11" textAnchor="end" fill={RED}>{tx('確率 {0}', event.text)}
        </text>
        <line x1={pad.left} x2={pad.left} y1={pad.top} y2={height - pad.bottom} stroke={INK} strokeWidth="1.5" />
        <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} stroke={INK} strokeWidth="1.5" />
        <text x={pad.left} y={height - 10} fontSize="10.5" textAnchor="middle" fill={MUTED}>
          0
        </text>
        <text x={width - pad.right} y={height - 10} fontSize="10.5" textAnchor="end" fill={MUTED}>
          {tx('{0} 回', xMax)}</text>
        {run.points.length > 0 && (
          <path d={run.points.map(([n, ratio], i) => `${i ? 'L' : 'M'}${sx(n).toFixed(1)},${sy(ratio).toFixed(1)}`).join('')} fill="none" stroke={BLUE} strokeWidth="2" strokeLinejoin="round" />
        )}
      </svg>
      <div className="sim-readout">
        <div className="sim-buttons">
          {[10, 100, 1000].map((count) => (
            <button key={count} className="btn" onClick={() => add(count)}>
              {tx('{0} 回投げる', count)}</button>
          ))}
          <button className="btn btn-quiet" disabled={!run.trials} onClick={() => setRun({ trials: 0, hits: 0, points: [] })}>{t('やり直す')}</button>
        </div>
        <p>{tx('投げた回数 {0} 回、起こった回数 {1} 回', <strong>{run.trials}</strong>, <strong>{run.hits}</strong>)}</p>
        <p className="sim-big">{tx('起こった割合 {0}', run.trials ? (run.hits / run.trials).toFixed(3) : '—')}</p>
      </div>
    </>
  )
}

// ───────── 単位円と三角比 ─────────

const EXACT: Record<'sin' | 'tan', Record<number, string | null>> = {
  sin: { 0: '0', 30: '1/2', 45: '√2/2', 60: '√3/2', 90: '1' },
  tan: { 0: '0', 30: '√3/3', 45: '1', 60: '√3', 90: null },
}

/** 30° と 45° の倍数の角の、正確な値（それ以外の角では undefined。値が無いときは null） */
function exactValue(kind: 'sin' | 'cos' | 'tan', degrees: number): string | null | undefined {
  const angle = ((degrees % 360) + 360) % 360
  const quadrant = Math.floor(angle / 90) % 4
  const within = angle % 90
  // 第 2・第 4 象限では、基準の角を 90° から測りなおす
  const reference = quadrant % 2 === 0 ? within : 90 - within
  if (!(reference in EXACT.sin)) return undefined
  const base = kind === 'tan' ? EXACT.tan[reference] : EXACT.sin[kind === 'sin' ? reference : 90 - reference]
  if (base === null || base === undefined) return null
  if (base === '0') return '0'
  const negative = kind === 'sin' ? quadrant >= 2 : kind === 'cos' ? quadrant === 1 || quadrant === 2 : quadrant === 1 || quadrant === 3
  return `${negative ? '−' : ''}${base}`
}

function UnitCircleView({ values }: SimViewProps) {
  const degrees = values['angle']
  const theta = (degrees * Math.PI) / 180
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const c = 150
  const r = 105
  const px = c + cos * r
  const py = c - sin * r
  const arc = 26
  const row = (name: 'sin' | 'cos' | 'tan', value: number, color: string) => {
    const exact = exactValue(name, degrees)
    const decimal = fixed(value, 3)
    // 正確な値があるときは、それを先に書く（√ をふくむ値の小数は、およその値）
    const shown = exact === null ? t('値はありません') : exact === undefined || exact === decimal ? decimal : `${exact} ${exact.includes('√') ? '≒' : '='} ${decimal}`
    return (
      <p key={name}>
        <strong style={{ color }}>{name} θ</strong> = {shown}
      </p>
    )
  }
  return (
    <>
      <svg viewBox="0 0 300 300" role="img" aria-label={t('単位円と、角 θ の位置にある点')} className="sim-square">
        <line x1="20" x2="284" y1={c} y2={c} stroke={INK} strokeWidth="1.5" />
        <line x1={c} x2={c} y1="284" y2="16" stroke={INK} strokeWidth="1.5" />
        <text x="288" y={c + 4} fontSize="12" fontStyle="italic" fill={INK}>
          x
        </text>
        <text x={c} y="12" fontSize="12" fontStyle="italic" textAnchor="middle" fill={INK}>
          y
        </text>
        <circle cx={c} cy={c} r={r} fill="none" stroke={MUTED} strokeWidth="1.5" />
        {(
          [
            [c + r + 9, c + 15, '1'],
            [c - r - 11, c + 15, '−1'],
            [c - 9, c - r - 5, '1'],
            [c - 11, c + r + 14, '−1'],
          ] as const
        ).map(([x, y, label], i) => (
          <text key={i} x={x} y={y} fontSize="11" textAnchor="middle" fill={MUTED}>
            {label}
          </text>
        ))}
        {/* 角のしるし */}
        {degrees > 0 && (
          <path
            d={`M${c + arc},${c} A${arc},${arc} 0 ${degrees > 180 ? 1 : 0} 0 ${(c + Math.cos(theta) * arc).toFixed(1)},${(c - Math.sin(theta) * arc).toFixed(1)}`}
            fill="none"
            stroke={GREEN}
            strokeWidth="2"
          />
        )}
        <line x1={c} y1={c} x2={px} y2={py} stroke={INK} strokeWidth="2" />
        {/* cos θ（x 座標）と sin θ（y 座標） */}
        <line x1={c} y1={c} x2={px} y2={c} stroke={BLUE} strokeWidth="4" strokeLinecap="round" />
        <line x1={px} y1={c} x2={px} y2={py} stroke={RED} strokeWidth="4" strokeLinecap="round" />
        <circle cx={px} cy={py} r="5.5" fill={INK} stroke="#fff" strokeWidth="2" />
        <text x={px + (cos >= 0 ? 9 : -9)} y={py + (sin >= 0 ? -9 : 17)} fontSize="13" fontWeight="700" textAnchor={cos >= 0 ? 'start' : 'end'} fill={INK}>
          P
        </text>
      </svg>
      <div className="sim-readout">
        <p className="sim-big">θ = {degrees}°</p>
        {row('sin', sin, RED)}
        {row('cos', cos, BLUE)}
        {row('tan', Math.tan(theta), GREEN)}
        <p className="muted">{tx('点 P の座標は（{0}, {1}）です。', fixed(cos, 3), fixed(sin, 3))}</p>
      </div>
    </>
  )
}

// ───────── ふりこ ─────────

/** 動かしている間の経過時間（秒）。playing が偽の間は止まる */
function useClock(playing: boolean): [number, () => void] {
  const [seconds, setSeconds] = useState(0)
  const last = useRef<number | null>(null)
  useEffect(() => {
    if (!playing) {
      last.current = null
      return
    }
    let frame = 0
    const tick = (now: number) => {
      if (last.current !== null) setSeconds((s) => s + Math.min(0.1, (now - last.current!) / 1000))
      last.current = now
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])
  return [seconds, () => setSeconds(0)]
}

function PendulumView({ values }: SimViewProps) {
  const [playing, setPlaying] = useState(false)
  const [seconds, reset] = useClock(playing)
  const period = pendulumPeriod(values['length'])
  // 長さやふれはばを変えたら、はじめの位置からやり直す
  useEffect(() => reset(), [values['length'], values['angle'], values['mass']])
  const amplitude = (values['angle'] * Math.PI) / 180
  const angle = amplitude * Math.cos((2 * Math.PI * seconds) / period)
  const cx = 180
  const top = 26
  const length = 40 + values['length'] * 1.45
  const bob = 8 + values['mass'] / 20
  const at = (a: number) => [cx + Math.sin(a) * length, top + Math.cos(a) * length]
  const [bx, by] = at(angle)
  const [lx, ly] = at(-amplitude)
  const [rx, ry] = at(amplitude)
  return (
    <>
      <svg viewBox="0 0 360 300" role="img" aria-label={t('ふりこ')}>
        <rect x={cx - 70} y={top - 12} width="140" height="12" fill="#b9b2a4" />
        <line x1={cx} y1={top} x2={cx} y2={top + length + 24} stroke={GRID} strokeWidth="1.5" strokeDasharray="4 4" />
        <path d={`M${lx.toFixed(1)},${ly.toFixed(1)} A${length},${length} 0 0 0 ${rx.toFixed(1)},${ry.toFixed(1)}`} fill="none" stroke="#c9cdd3" strokeWidth="1.5" strokeDasharray="3 4" />
        <line x1={cx} y1={top} x2={bx} y2={by} stroke={INK} strokeWidth="1.5" />
        <circle cx={bx} cy={by} r={bob} fill={BLUE} stroke={INK} strokeWidth="1.5" />
        <circle cx={cx} cy={top} r="3" fill={INK} />
      </svg>
      <div className="sim-readout">
        <div className="sim-buttons">
          <button className="btn" onClick={() => setPlaying(!playing)}>
            {playing ? t('止める') : t('動かす')}
          </button>
          <button className="btn btn-quiet" disabled={seconds === 0} onClick={reset}>{t('はじめの位置へ')}</button>
        </div>
        <p className="sim-big">{tx('1 往復の時間 {0} 秒', period.toFixed(2))}</p>
        <p>{tx('10 往復の時間 {0} 秒', (period * 10).toFixed(1))}</p>
        <p className="muted">{tx('動かしてから {0} 秒、{1} 往復しました。', seconds.toFixed(1), Math.floor(seconds / period))}</p>
      </div>
    </>
  )
}

// ───────── てこ ─────────

function LeverView({ values }: SimViewProps) {
  const left = values['leftWeight'] * values['leftArm']
  const right = values['rightWeight'] * values['rightArm']
  const tilt = left === right ? 0 : left > right ? -9 : 9
  const cx = 260
  const cy = 78
  const unit = 36
  /** おもり。うでがかたむいても、糸はまっすぐ下にたれる */
  const weight = (side: -1 | 1, grams: number, arm: number, color: string) => {
    const turn = (tilt * Math.PI) / 180
    const x = cx + side * arm * unit * Math.cos(turn)
    const y = cy + side * arm * unit * Math.sin(turn)
    const size = 16 + grams * 0.45
    return (
      <g>
        <line x1={x} x2={x} y1={y + 4} y2={y + 34} stroke={INK} strokeWidth="1.5" />
        <rect x={x - size / 2} y={y + 34} width={size} height={size} rx="3" fill={color} stroke={INK} strokeWidth="1.5" />
        <text x={x} y={y + 34 + size + 14} fontSize="11.5" textAnchor="middle" fill={INK}>
          {grams} g
        </text>
      </g>
    )
  }
  return (
    <>
      <svg viewBox="0 0 520 220" role="img" aria-label={t('てこ')}>
        <polygon points={`${cx},${cy + 6} ${cx - 22},${cy + 120} ${cx + 22},${cy + 120}`} fill="#b9b2a4" stroke={INK} strokeWidth="1.5" />
        <line x1={cx - 70} x2={cx + 70} y1={cy + 120} y2={cy + 120} stroke={INK} strokeWidth="2" />
        <g transform={`rotate(${tilt} ${cx} ${cy})`}>
          <rect x={cx - unit * 6 - 14} y={cy - 5} width={unit * 12 + 28} height="10" rx="2" fill="#e9d9b8" stroke={INK} strokeWidth="1.5" />
          {[1, 2, 3, 4, 5, 6].flatMap((n) =>
            [-1, 1].map((side) => (
              <g key={`${side}${n}`}>
                <line x1={cx + side * n * unit} x2={cx + side * n * unit} y1={cy - 5} y2={cy + 5} stroke={INK} strokeWidth="1" />
                <text x={cx + side * n * unit} y={cy - 10} fontSize="11" textAnchor="middle" fill={MUTED}>
                  {n}
                </text>
              </g>
            )),
          )}
        </g>
        {weight(-1, values['leftWeight'], values['leftArm'], BLUE)}
        {weight(1, values['rightWeight'], values['rightArm'], RED)}
        <circle cx={cx} cy={cy} r="4" fill={INK} />
      </svg>
      <div className="sim-readout">
        <p>
          <strong style={{ color: BLUE }}>{t('左')}</strong> {values['leftWeight']} × {values['leftArm']} = <strong>{left}</strong>
        </p>
        <p>
          <strong style={{ color: RED }}>{t('右')}</strong> {values['rightWeight']} × {values['rightArm']} = <strong>{right}</strong>
        </p>
        <p className="sim-big">{left === right ? t('つり合います') : left > right ? t('左にかたむきます') : t('右にかたむきます')}</p>
      </div>
    </>
  )
}

// ───────── ばね ─────────

function SpringView({ values }: SimViewProps) {
  const force = values['weights'] * 0.2
  const stretch = force * values['stretch']
  const x = 90
  const top = 22
  const natural = 70
  const scale = 6
  const bottom = top + natural + stretch * scale
  const coils = 9
  const zigzag = Array.from({ length: coils * 2 + 1 }, (_, i) => `${x + (i === 0 || i === coils * 2 ? 0 : i % 2 ? 11 : -11)},${(top + 8 + ((bottom - top - 16) * i) / (coils * 2)).toFixed(1)}`).join(' ')
  // 右のグラフ: 横軸が力（0〜2 N）、縦軸がのび（0〜20 cm）
  const gx = (n: number) => 250 + (n / 2) * 230
  const gy = (cm: number) => 250 - (cm / 20) * 210
  return (
    <>
      <svg viewBox="0 0 520 290" role="img" aria-label={t('ばねと、力とのびのグラフ')}>
        <rect x={x - 46} y={top - 10} width="92" height="10" fill="#b9b2a4" />
        <line x1={x} y1={top} x2={x} y2={top + 8} stroke={INK} strokeWidth="1.5" />
        <polyline points={zigzag} fill="none" stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
        <line x1={x} y1={bottom - 8} x2={x} y2={bottom} stroke={INK} strokeWidth="1.5" />
        {Array.from({ length: values['weights'] }, (_, i) => (
          <rect key={i} x={x - 13} y={bottom + i * 7.5} width="26" height="7" rx="1.5" fill={BLUE} stroke={INK} strokeWidth="1" />
        ))}
        {/* もとの長さと、のび */}
        <line x1={x + 34} x2={x + 62} y1={top + natural} y2={top + natural} stroke={MUTED} strokeDasharray="3 3" />
        {stretch > 0 && (
          <>
            <line x1={x + 34} x2={x + 62} y1={bottom} y2={bottom} stroke={RED} />
            <line x1={x + 50} x2={x + 50} y1={top + natural} y2={bottom} stroke={RED} strokeWidth="2" />
            <text x={x + 58} y={(top + natural + bottom) / 2 + 4} fontSize="12" fill={RED}>{t('のび')}</text>
          </>
        )}
        {[0, 0.5, 1, 1.5, 2].map((n) => (
          <g key={`f${n}`}>
            <line x1={gx(n)} x2={gx(n)} y1={gy(0)} y2={gy(20)} stroke={GRID} />
            <text x={gx(n)} y={gy(0) + 15} fontSize="10.5" textAnchor="middle" fill={MUTED}>
              {n}
            </text>
          </g>
        ))}
        {[0, 5, 10, 15, 20].map((cm) => (
          <g key={`s${cm}`}>
            <line x1={gx(0)} x2={gx(2)} y1={gy(cm)} y2={gy(cm)} stroke={GRID} />
            <text x={gx(0) - 6} y={gy(cm) + 4} fontSize="10.5" textAnchor="end" fill={MUTED}>
              {cm}
            </text>
          </g>
        ))}
        <line x1={gx(0)} x2={gx(2)} y1={gy(0)} y2={gy(0)} stroke={INK} strokeWidth="1.5" />
        <line x1={gx(0)} x2={gx(0)} y1={gy(0)} y2={gy(20)} stroke={INK} strokeWidth="1.5" />
        <text x={gx(2)} y={gy(0) + 30} fontSize="11" textAnchor="end" fill={INK}>{t('力の大きさ〔N〕')}</text>
        <text x={gx(0) - 4} y={gy(20) - 8} fontSize="11" textAnchor="middle" fill={INK}>{t('のび〔cm〕')}</text>
        <line x1={gx(0)} y1={gy(0)} x2={gx(2)} y2={gy(2 * values['stretch'])} stroke={BLUE} strokeWidth="2" />
        <circle cx={gx(force)} cy={gy(stretch)} r="5.5" fill={RED} stroke="#fff" strokeWidth="2" />
      </svg>
      <div className="sim-readout">
        <p>{tx('ばねを引く力 {0}', <strong>{fixed(force, 1)} N</strong>)}
        </p>
        <p className="sim-big">{tx('ばねののび {0} cm', fixed(stretch, 1))}</p>
      </div>
    </>
  )
}

// ───────── 回路 ─────────

/** 電流の表し方（1 A より小さいときは、mA も添える） */
const amps = (value: number) => (value < 1 ? `${fixed(value, 3)} A（${fixed(value * 1000, 0)} mA）` : `${fixed(value, 2)} A`)

function CircuitView({ values, choices }: SimViewProps) {
  const parallel = choices['wiring'] === 'parallel'
  const single = choices['wiring'] === 'single'
  const result = circuitValues(values['voltage'], values['r1'], values['r2'], choices['wiring'])
  const wire = { stroke: INK, strokeWidth: 2, fill: 'none' }
  const resistor = (x: number, y: number, name: string, ohms: number, color: string) => (
    <g>
      <rect x={x - 34} y={y - 11} width="68" height="22" fill="#fff" stroke={color} strokeWidth="2.5" />
      <text x={x} y={y - 18} fontSize="12" textAnchor="middle" fill={color} fontWeight="700">
        {name} {ohms} Ω
      </text>
    </g>
  )
  return (
    <>
      <svg viewBox="0 0 520 250" role="img" aria-label={single ? t('抵抗が 1 つの回路') : parallel ? t('並列回路') : t('直列回路')}>
        {/* 電源（長いほうが＋極） */}
        <path d="M70,60 V112 M70,128 V200" {...wire} />
        <line x1="52" x2="88" y1="112" y2="112" stroke={INK} strokeWidth="2" />
        <line x1="60" x2="80" y1="128" y2="128" stroke={INK} strokeWidth="5" />
        <text x="44" y="110" fontSize="13" textAnchor="end" fill={INK}>
          ＋
        </text>
        <text x="44" y="136" fontSize="13" textAnchor="end" fill={INK}>
          −
        </text>
        <text x="96" y="124" fontSize="12" fill={INK} fontWeight="700">
          {fixed(values['voltage'], 1)} V
        </text>
        {parallel ? (
          <>
            <path d="M70,60 H250 M250,60 V40 H450 V60 M250,60 V110 H450 V60 M450,60 V200 H70" {...wire} />
            {resistor(350, 40, 'R₁', values['r1'], BLUE)}
            {resistor(350, 110, 'R₂', values['r2'], RED)}
            <text x="350" y="68" fontSize="11.5" textAnchor="middle" fill={BLUE}>
              {amps(result.i1)}
            </text>
            <text x="350" y="138" fontSize="11.5" textAnchor="middle" fill={RED}>
              {amps(result.i2)}
            </text>
          </>
        ) : single ? (
          <>
            <path d="M70,60 H450 V200 H70" {...wire} />
            {resistor(300, 60, 'R₁', values['r1'], BLUE)}
            <text x="300" y="88" fontSize="11.5" textAnchor="middle" fill={BLUE}>
              {fixed(result.v1, 2)} V
            </text>
          </>
        ) : (
          <>
            <path d="M70,60 H450 V200 H70" {...wire} />
            {resistor(220, 60, 'R₁', values['r1'], BLUE)}
            {resistor(370, 60, 'R₂', values['r2'], RED)}
            <text x="220" y="88" fontSize="11.5" textAnchor="middle" fill={BLUE}>
              {fixed(result.v1, 2)} V
            </text>
            <text x="370" y="88" fontSize="11.5" textAnchor="middle" fill={RED}>
              {fixed(result.v2, 2)} V
            </text>
          </>
        )}
        {/* 電流の向き（＋極から出て、−極へもどる） */}
        <polygon points="150,60 138,54 138,66" fill={GREEN} />
        <polygon points="250,200 262,194 262,206" fill={GREEN} />
        <text x="150" y="48" fontSize="11.5" textAnchor="middle" fill={GREEN}>{t('電流')}</text>
        <text x="260" y="222" fontSize="12" textAnchor="middle" fill={GREEN} fontWeight="700">{tx('全体 {0}', amps(result.total))}
        </text>
      </svg>
      <div className="sim-readout">
        <table className="sim-table">
          <thead>
            <tr>
              <th />
              <th>{t('電流')}</th>
              <th>{t('電圧')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th style={{ color: BLUE }}>R₁</th>
              <td>{amps(result.i1)}</td>
              <td>{fixed(result.v1, 2)} V</td>
            </tr>
            {!single && (
              <tr>
                <th style={{ color: RED }}>R₂</th>
                <td>{amps(result.i2)}</td>
                <td>{fixed(result.v2, 2)} V</td>
              </tr>
            )}
            {!single && (
              <tr>
                <th>{t('全体')}</th>
                <td>{amps(result.total)}</td>
                <td>{fixed(values['voltage'], 1)} V</td>
              </tr>
            )}
          </tbody>
        </table>
        {single ? (
          <p className="muted">{tx('電流 = 電圧 ÷ 抵抗 = {0} V ÷ {1} Ω', fixed(values['voltage'], 1), values['r1'])}</p>
        ) : (
          <p className="muted">{tx('回路全体の抵抗は {0} Ω です。', fixed(result.resistance, 2))}</p>
        )}
      </div>
    </>
  )
}

// ───────── 凸レンズ ─────────

function LensView({ values }: SimViewProps) {
  const clipId = useId()
  const focal = values['focal']
  const distance = values['distance']
  const result = lensImage(focal, distance)
  const width = 640
  const height = 300
  const cx = 300
  const axis = 150
  const scale = 4 // 1 cm を 4 画素で描く
  const tall = 44 // 物体の高さ（画素）
  const objectX = cx - distance * scale
  const objectY = axis - tall
  const imageX = cx + result.image * scale
  const imageY = axis + (result.image / distance) * tall
  /** 2 点を通る直線を、from から右はし（または左はし）までのばす */
  const extend = (x1: number, y1: number, x2: number, y2: number, toX: number) => `M${x1},${y1} L${toX},${(y1 + ((y2 - y1) * (toX - x1)) / (x2 - x1)).toFixed(1)}`
  const arrow = (x: number, tipY: number, color: string, dashed = false) => (
    <g opacity={dashed ? 0.75 : 1}>
      <line x1={x} y1={axis} x2={x} y2={tipY} stroke={color} strokeWidth="3" strokeDasharray={dashed ? '6 4' : undefined} />
      <polygon points={`${x},${tipY} ${x - 6},${tipY + (tipY < axis ? 11 : -11)} ${x + 6},${tipY + (tipY < axis ? 11 : -11)}`} fill={color} />
    </g>
  )
  return (
    <>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('凸レンズを通る光の道すじと、できる像')}>
        <defs>
          <clipPath id={clipId}>
            <rect x="0" y="0" width={width} height={height} />
          </clipPath>
        </defs>
        <line x1="0" x2={width} y1={axis} y2={axis} stroke={MUTED} strokeWidth="1" />
        {/* レンズと焦点 */}
        <ellipse cx={cx} cy={axis} rx="9" ry="120" fill="#cfeaf1" stroke={BLUE} strokeWidth="1.5" />
        <line x1={cx} x2={cx} y1={axis - 120} y2={axis + 120} stroke={BLUE} strokeWidth="1" strokeDasharray="3 3" />
        {[-1, 1].map((side) => (
          <g key={side}>
            <circle cx={cx + side * focal * scale} cy={axis} r="3.5" fill={INK} />
            <text x={cx + side * focal * scale} y={axis + 17} fontSize="11.5" textAnchor="middle" fill={INK}>{t('焦点')}</text>
          </g>
        ))}
        <g clipPath={`url(#${clipId})`}>
          {/* ① 光軸に平行な光は、レンズを通ったあと、反対側の焦点を通る */}
          <path d={`M${objectX},${objectY} L${cx},${objectY}`} stroke={RED} strokeWidth="1.5" fill="none" />
          <path d={extend(cx, objectY, cx + focal * scale, axis, width)} stroke={RED} strokeWidth="1.5" fill="none" />
          {/* ② レンズの中心を通る光は、まっすぐ進む */}
          <path d={extend(objectX, objectY, cx, axis, width)} stroke={GREEN} strokeWidth="1.5" fill="none" />
          {result.kind === 'virtual' && (
            <>
              {/* 虚像: レンズを通ったあとの光を、逆向きにのばした線が集まる所 */}
              <line x1={cx} y1={objectY} x2={imageX} y2={imageY} stroke={RED} strokeWidth="1.2" strokeDasharray="5 4" />
              <line x1={objectX} y1={objectY} x2={imageX} y2={imageY} stroke={GREEN} strokeWidth="1.2" strokeDasharray="5 4" />
            </>
          )}
          {result.kind !== 'none' && arrow(imageX, imageY, '#8a5fb5', result.kind === 'virtual')}
        </g>
        {arrow(objectX, objectY, INK)}
        <text x={objectX} y={axis + 32} fontSize="11.5" textAnchor="middle" fill={INK}>{t('物体')}</text>
      </svg>
      <div className="sim-readout">
        {result.kind === 'none' ? (
          <p className="sim-big">{t('像はできません')}</p>
        ) : (
          <>
            <p className="sim-big">{result.kind === 'real' ? t('実像（上下左右が逆向き）') : t('虚像（物体と同じ向き）')}</p>
            <p>{tx('像の位置: レンズから {0}（{1}）', <strong>{fixed(Math.abs(result.image), 1)} cm</strong>, result.kind === 'real' ? t('物体と反対側') : t('物体と同じ側'))}</p>
            <p>{tx('像の大きさ: 物体の {0}', <strong>{tx('{0} 倍', fixed(result.scale, 2))}</strong>)}
            </p>
            {(imageX < 0 || imageX > width) && <p className="muted">{t('（像は、図の外にできています）')}</p>}
          </>
        )}
        {result.kind === 'none' && <p className="muted">{t('物体が焦点の上にあるとき、レンズを通った光は平行に進み、集まりません。')}</p>}
        <p className="muted">{tx('赤: 光軸に平行な光　緑: レンズの中心を通る光{0}', result.kind === 'virtual' ? t('　点線: 光を逆向きにのばした線') : '')}</p>
      </div>
    </>
  )
}

// ───────── 月の満ち欠け ─────────

/** 地球から見た月の形。position は新月から回った角度（°）。北半球で南の空に見たときの向き */
function MoonFace({ position, cx, cy, r }: { position: number; cx: number; cy: number; r: number }) {
  const waning = position > 180
  const phase = waning ? 360 - position : position
  const rx = Math.abs(Math.cos((phase * Math.PI) / 180)) * r
  // 光っている側のふち（右）を上から下へ、明暗の境目（だ円）を下から上へたどる
  const lit = `M0,${-r} A${r},${r} 0 0 1 0,${r} A${rx.toFixed(2)},${r} 0 0 ${phase > 90 ? 1 : 0} 0,${-r} Z`
  return (
    <g transform={`translate(${cx} ${cy})${waning ? ' scale(-1 1)' : ''}`}>
      <circle r={r} fill="#3a3f4b" />
      <path d={lit} fill={YELLOW} />
      <circle r={r} fill="none" stroke={INK} strokeWidth="1.5" />
    </g>
  )
}

function MoonView({ values }: SimViewProps) {
  const position = values['position']
  const angle = (position * Math.PI) / 180
  const ex = 150
  const ey = 140
  const orbit = 88
  const mx = ex + Math.cos(angle) * orbit
  const my = ey - Math.sin(angle) * orbit
  const half = (cx: number, cy: number, r: number, dark: string, light: string) => (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={dark} />
      <path d={`M${cx},${cy - r} A${r},${r} 0 0 1 ${cx},${cy + r} Z`} fill={light} />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={INK} strokeWidth="1.2" />
    </g>
  )
  return (
    <>
      <svg viewBox="0 0 520 280" role="img" aria-label={t('太陽・地球・月の位置と、地球から見た月の形')}>
        <text x="150" y="16" fontSize="12" textAnchor="middle" fill={MUTED}>{t('北極の上から見た図')}</text>
        {/* 太陽の光（右から） */}
        {[80, 140, 200].map((y) => (
          <g key={y}>
            <line x1="330" x2="288" y1={y} y2={y} stroke="#e8a013" strokeWidth="2" />
            <polygon points={`282,${y} 292,${y - 5} 292,${y + 5}`} fill="#e8a013" />
          </g>
        ))}
        <text x="310" y="232" fontSize="12" textAnchor="middle" fill="#a66f00">{t('太陽の光')}</text>
        <circle cx={ex} cy={ey} r={orbit} fill="none" stroke={MUTED} strokeDasharray="3 5" />
        {half(ex, ey, 17, '#27506b', '#5fb0d6')}
        <text x={ex} y={ey + 34} fontSize="11.5" textAnchor="middle" fill={INK}>{t('地球')}</text>
        {half(mx, my, 11, '#3a3f4b', YELLOW)}
        <text x={mx} y={my - 16} fontSize="11.5" textAnchor="middle" fill={INK}>{t('月')}</text>
        <text x="425" y="16" fontSize="12" textAnchor="middle" fill={MUTED}>{t('地球から見た月')}</text>
        <rect x="350" y="28" width="150" height="150" rx="10" fill="#1d2230" />
        <MoonFace position={position} cx={425} cy={103} r={56} />
      </svg>
      <div className="sim-readout">
        <p className="sim-big">{moonName(position)}</p>
        <p>{tx('新月から 約 {0} 日', fixed((position / 360) * 29.5, 0))}</p>
        <p className="muted">{t('月は、いつも太陽のほうを向いた半分が光っています。地球から見える向きによって、形が変わって見えます。')}</p>
      </div>
    </>
  )
}

export const SIM_VIEWS: Record<string, (props: SimViewProps) => ReactNode> = {
  fraction: FractionView,
  graph: GraphView,
  dice: DiceView,
  unitcircle: UnitCircleView,
  pendulum: PendulumView,
  lever: LeverView,
  spring: SpringView,
  circuit: CircuitView,
  lens: LensView,
  moon: MoonView,
}
