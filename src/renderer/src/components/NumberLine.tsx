import { t } from '@/lib/i18n'
interface Spec {
  min: number
  max: number
  points?: { at: number; label?: string; color?: string }[]
  arrows?: { from: number; to: number; label?: string; color?: string }[]
  ranges?: { from: number; to: number; label?: string; color?: string }[]
}

const COLORS: Record<string, string> = {
  red: '#d2553f',
  blue: '#3878b8',
  green: '#3d9467',
  ink: '#2c2a35',
}

/** 数の前の「-」を、数学のマイナス記号に置きかえる */
const minus = (text: string) => text.replace(/-(?=\d)/g, '−')

/**
 * 教科書の本文に埋め込む数直線の図。
 * ```numberline のコードブロックに書かれた JSON から描く。
 */
export function NumberLine({ source }: { source: string }) {
  let spec: Spec
  try {
    spec = JSON.parse(source) as Spec
    if (typeof spec.min !== 'number' || typeof spec.max !== 'number' || spec.max <= spec.min) throw new Error()
  } catch {
    return <p className="figure-error">{t('（図を表示できませんでした）')}</p>
  }

  const points = spec.points ?? []
  const arrows = spec.arrows ?? []
  const ranges = spec.ranges ?? []
  const width = 680
  const pad = 44
  const x = (v: number) => pad + ((v - spec.min) / (spec.max - spec.min)) * (width - pad * 2)

  const pointLabels = points.some((p) => p.label)
  const arrowBase = pointLabels ? 34 : 18
  const axisY = 16 + arrowBase + arrows.length * 26
  const height = axisY + 34 + (ranges.length ? 30 : 0)

  const span = spec.max - spec.min
  const labelStep = span > 30 ? 5 : span > 16 ? 2 : 1
  const ticks: number[] = []
  for (let v = Math.ceil(spec.min); v <= Math.floor(spec.max); v++) ticks.push(v)

  return (
    <figure className="numberline">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('数直線の図')}>
        <defs>
          {Object.entries(COLORS).map(([name, color]) => (
            <marker key={name} id={`nl-arrow-${name}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,1 L9,5 L0,9 z" fill={color} />
            </marker>
          ))}
        </defs>

        {/* 軸 */}
        <line x1={pad - 26} y1={axisY} x2={width - pad + 26} y2={axisY} stroke={COLORS.ink} strokeWidth="1.6" markerStart="url(#nl-arrow-ink)" markerEnd="url(#nl-arrow-ink)" />
        {ticks.map((v) => (
          <g key={v}>
            <line x1={x(v)} y1={axisY - (v === 0 ? 8 : 5)} x2={x(v)} y2={axisY + (v === 0 ? 8 : 5)} stroke={COLORS.ink} strokeWidth={v === 0 ? 2 : 1.2} />
            {v % labelStep === 0 && (
              <text x={x(v)} y={axisY + 24} textAnchor="middle" fontSize="14" fill={COLORS.ink} fontWeight={v === 0 ? 700 : 400}>
                {minus(String(v))}
              </text>
            )}
          </g>
        ))}

        {/* 範囲（負の数・正の数 など） */}
        {ranges.map((r, i) => {
          const color = COLORS[r.color ?? 'ink'] ?? COLORS.ink
          const y = axisY + 40
          return (
            <g key={i}>
              <line x1={x(r.from)} y1={y} x2={x(r.to)} y2={y} stroke={color} strokeWidth="5" strokeLinecap="round" opacity="0.55" />
              {r.label && (
                <text x={(x(r.from) + x(r.to)) / 2} y={y + 20} textAnchor="middle" fontSize="13.5" fontWeight="700" fill={color}>
                  {r.label}
                </text>
              )}
            </g>
          )
        })}

        {/* 移動を表す矢印。下から順に積み上げる */}
        {arrows.map((a, i) => {
          const name = a.color && COLORS[a.color] ? a.color : 'ink'
          const y = axisY - arrowBase - i * 26
          return (
            <g key={i}>
              <line x1={x(a.from)} y1={y} x2={x(a.to)} y2={y} stroke={COLORS[name]} strokeWidth="2.4" markerEnd={`url(#nl-arrow-${name})`} />
              <line x1={x(a.from)} y1={y - 5} x2={x(a.from)} y2={y + 5} stroke={COLORS[name]} strokeWidth="2" />
              {a.label && (
                <text x={(x(a.from) + x(a.to)) / 2} y={y - 7} textAnchor="middle" fontSize="13.5" fontWeight="700" fill={COLORS[name]}>
                  {minus(a.label)}
                </text>
              )}
            </g>
          )
        })}

        {/* 点 */}
        {points.map((p, i) => {
          const color = COLORS[p.color ?? 'ink'] ?? COLORS.ink
          return (
            <g key={i}>
              <circle cx={x(p.at)} cy={axisY} r="5.5" fill={color} stroke="#fff" strokeWidth="1.5" />
              {p.label && (
                <text x={x(p.at)} y={axisY - 13} textAnchor="middle" fontSize="13.5" fontWeight="700" fill={color}>
                  {minus(p.label)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </figure>
  )
}
