import { createElement, useId, type ReactNode } from 'react'
import { FIGURE_ATTRIBUTES, FIGURE_ELEMENTS, compileExpression, safeFigureValue } from '@shared/figures'
import { t } from '@/lib/i18n'

/**
 * 教科書の本文に埋めこむ図。
 *   Plot   … 関数のグラフと座標（式から正確に描く）
 *   Figure … AI が書いた SVG の図（使ってよい要素と属性だけを通す）
 */

const INK = '#2c2a35'
const COLORS = ['#0e86a0', '#d2553f', '#3d9467', '#8a5fb5']

// ───────── 関数のグラフ ─────────

interface PlotSpec {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  functions?: { expr: string; label?: string }[]
  points?: { x: number; y: number; label?: string }[]
}

const minus = (n: number) => String(n).replace('-', '−')

/** 目もりの間かく。範囲に合わせて、1・2・5 の倍数から 10 本前後になるものを選ぶ */
function tickStep(span: number): number {
  const rough = span / 10
  const base = Math.pow(10, Math.floor(Math.log10(rough)))
  return [1, 2, 5, 10].map((m) => m * base).find((s) => s >= rough) ?? base * 10
}

export function Plot({ source }: { source: string }) {
  const clipId = useId()
  let spec: PlotSpec
  let curves: { label?: string; fn: (x: number) => number }[]
  try {
    spec = JSON.parse(source) as PlotSpec
    if (![spec.xMin, spec.xMax, spec.yMin, spec.yMax].every(Number.isFinite) || spec.xMax <= spec.xMin || spec.yMax <= spec.yMin) throw new Error()
    curves = (spec.functions ?? []).slice(0, 4).map((f) => ({ label: f.label, fn: compileExpression(String(f.expr)) }))
  } catch {
    return <p className="figure-error">{t('（グラフを表示できませんでした）')}</p>
  }

  const size = 360
  const pad = 30
  const sx = (x: number) => pad + ((x - spec.xMin) / (spec.xMax - spec.xMin)) * (size - pad * 2)
  const sy = (y: number) => size - pad - ((y - spec.yMin) / (spec.yMax - spec.yMin)) * (size - pad * 2)
  const ticks = (min: number, max: number) => {
    const step = tickStep(max - min)
    const values: number[] = []
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) values.push(Math.round(v / step) * step)
    return values
  }
  const xTicks = ticks(spec.xMin, spec.xMax)
  const yTicks = ticks(spec.yMin, spec.yMax)
  // 軸は 0 の位置に引く。0 が範囲の外なら、いちばん近い端に寄せる
  const axisX = sx(Math.max(spec.xMin, Math.min(spec.xMax, 0)))
  const axisY = sy(Math.max(spec.yMin, Math.min(spec.yMax, 0)))

  /** 曲線を折れ線で近似する。値が無い所や、急に飛ぶ所（反比例の x=0 など）では線を切る */
  const pathOf = (fn: (x: number) => number) => {
    const steps = 240
    const limit = (spec.yMax - spec.yMin) * 2
    let d = ''
    let previous: number | null = null
    for (let i = 0; i <= steps; i++) {
      const x = spec.xMin + ((spec.xMax - spec.xMin) * i) / steps
      const y = fn(x)
      const broken = !Number.isFinite(y) || Math.abs(y) > Math.abs(spec.yMax) + limit || (previous !== null && Math.abs(y - previous) > limit)
      if (!Number.isFinite(y) || Math.abs(y) > Math.abs(spec.yMax) + limit + Math.abs(spec.yMin)) {
        previous = null
        continue
      }
      d += `${previous === null || broken ? 'M' : 'L'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`
      previous = y
    }
    return d
  }

  return (
    <figure className="numberline plot">
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={t('関数のグラフ')}>
        <defs>
          <clipPath id={clipId}>
            <rect x={pad} y={pad} width={size - pad * 2} height={size - pad * 2} />
          </clipPath>
        </defs>
        {xTicks.map((v) => (
          <line key={`x${v}`} x1={sx(v)} x2={sx(v)} y1={pad} y2={size - pad} stroke="#e2e6ea" strokeWidth="1" />
        ))}
        {yTicks.map((v) => (
          <line key={`y${v}`} x1={pad} x2={size - pad} y1={sy(v)} y2={sy(v)} stroke="#e2e6ea" strokeWidth="1" />
        ))}
        <line x1={pad - 6} x2={size - pad + 10} y1={axisY} y2={axisY} stroke={INK} strokeWidth="1.5" />
        <line x1={axisX} x2={axisX} y1={size - pad + 6} y2={pad - 10} stroke={INK} strokeWidth="1.5" />
        <text x={size - pad + 14} y={axisY + 4} fontSize="13" fontStyle="italic" fill={INK}>
          x
        </text>
        <text x={axisX} y={pad - 14} fontSize="13" fontStyle="italic" textAnchor="middle" fill={INK}>
          y
        </text>
        {xTicks
          .filter((v) => v !== 0)
          .map((v) => (
            <text key={`xl${v}`} x={sx(v)} y={axisY + 15} fontSize="10.5" textAnchor="middle" fill="#5c596b">
              {minus(v)}
            </text>
          ))}
        {yTicks
          .filter((v) => v !== 0)
          .map((v) => (
            <text key={`yl${v}`} x={axisX - 6} y={sy(v) + 4} fontSize="10.5" textAnchor="end" fill="#5c596b">
              {minus(v)}
            </text>
          ))}
        <text x={axisX - 6} y={axisY + 14} fontSize="10.5" textAnchor="end" fill="#5c596b">
          O
        </text>
        <g clipPath={`url(#${clipId})`}>
          {curves.map((curve, i) => (
            <path key={i} d={pathOf(curve.fn)} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="2" strokeLinejoin="round" />
          ))}
        </g>
        {(spec.points ?? []).slice(0, 12).map((p, i) => (
          <g key={i}>
            <circle cx={sx(p.x)} cy={sy(p.y)} r="4.5" fill={INK} stroke="#fff" strokeWidth="2" />
            {p.label && (
              <text x={sx(p.x) + 8} y={sy(p.y) - 8} fontSize="12" fontWeight="700" fill={INK}>
                {p.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      {curves.some((c) => c.label) && (
        <figcaption className="plot-legend">
          {curves.map((curve, i) =>
            curve.label ? (
              <span key={i}>
                <i style={{ background: COLORS[i % COLORS.length] }} />
                {curve.label}
              </span>
            ) : null,
          )}
        </figcaption>
      )}
    </figure>
  )
}

// ───────── SVG の図 ─────────

/** SVG の要素を、使ってよい要素と属性だけを残して React の要素に組み立てなおす */
function rebuild(node: Element, key: number, depth: number): ReactNode {
  if (depth > 8 || !FIGURE_ELEMENTS.has(node.localName)) return null
  const props: Record<string, string | number> = { key }
  for (const attribute of Array.from(node.attributes)) {
    if (!FIGURE_ATTRIBUTES.has(attribute.name) || !safeFigureValue(attribute.value)) continue
    props[attribute.name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = attribute.value
  }
  const children: ReactNode[] = []
  Array.from(node.childNodes).forEach((child, i) => {
    if (child.nodeType === Node.TEXT_NODE) {
      if (node.localName === 'text' || node.localName === 'tspan' || node.localName === 'title') children.push(child.textContent)
    } else if (child.nodeType === Node.ELEMENT_NODE) children.push(rebuild(child as Element, i, depth + 1))
  })
  return createElement(node.localName, props, ...children)
}

export function Figure({ source }: { source: string }) {
  const parsed = new DOMParser().parseFromString(source.trim(), 'image/svg+xml')
  const root = parsed.documentElement
  if (root.localName !== 'svg' || parsed.querySelector('parsererror') || root.querySelectorAll('*').length > 400) {
    return <p className="figure-error">{t('（図を表示できませんでした）')}</p>
  }
  return <figure className="numberline figure">{rebuild(root, 0, 0)}</figure>
}
