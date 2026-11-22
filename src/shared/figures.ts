import { t } from './i18n.ts'
/**
 * 教科書の本文に埋めこむ図（```plot と ```figure）の決まり。
 * 画面の描画と、教材の検査スクリプト（scripts/check-lessons.mjs）の両方から使う。
 */

const FUNCTIONS: Record<string, (v: number) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  log: Math.log,
  exp: Math.exp,
}

/**
 * 「2*x+1」のような式を、x から値を求める関数にする。
 * eval は使わず、決まった記号と関数だけを自分で読み取る（AI が書いた文字列をそのまま実行しないため）。
 * 使えるもの: 数、x、pi、e、+ - * / ^、かっこ、sqrt abs sin cos tan log exp。「2x」のようなかけ算の省略も読める。
 */
export function compileExpression(source: string): (x: number) => number {
  const cleaned = source.replace(/\s+/g, '').replace(/−/g, '-')
  const tokens = cleaned.match(/\d+\.?\d*|[a-z]+|[-+*/^()]/gi) ?? []
  if (tokens.join('') !== cleaned) throw new Error(t('式を読み取れません'))
  let at = 0
  type Node = (x: number) => number

  const primary = (): Node => {
    const token = tokens[at++]
    if (token === undefined) throw new Error(t('式が途中で終わっています'))
    if (token === '(') {
      const inner = sum()
      if (tokens[at++] !== ')') throw new Error(t('かっこが閉じていません'))
      return inner
    }
    if (token === '-') {
      const value = power()
      return (x) => -value(x)
    }
    if (token === '+') return power()
    if (/^\d/.test(token)) {
      const value = Number(token)
      return () => value
    }
    const name = token.toLowerCase()
    if (name === 'x') return (x) => x
    if (name === 'pi') return () => Math.PI
    if (name === 'e') return () => Math.E
    const fn = FUNCTIONS[name]
    if (!fn || tokens[at] !== '(') throw new Error(t('使えない名前です: {0}', token))
    const arg = primary()
    return (x) => fn(arg(x))
  }
  const implicit = () => at < tokens.length && /^[a-z(\d]/i.test(tokens[at])
  const power = (): Node => {
    const base = primary()
    if (tokens[at] !== '^') return base
    at++
    const exponent = power()
    return (x) => Math.pow(base(x), exponent(x))
  }
  const product = (): Node => {
    let left = power()
    for (;;) {
      if (tokens[at] === '*' || tokens[at] === '/') {
        const op = tokens[at++]
        const right = power()
        const l = left
        left = op === '*' ? (x) => l(x) * right(x) : (x) => l(x) / right(x)
      } else if (implicit()) {
        const right = power()
        const l = left
        left = (x) => l(x) * right(x)
      } else return left
    }
  }
  const sum = (): Node => {
    let left = product()
    while (tokens[at] === '+' || tokens[at] === '-') {
      const op = tokens[at++]
      const right = product()
      const l = left
      left = op === '+' ? (x) => l(x) + right(x) : (x) => l(x) - right(x)
    }
    return left
  }
  const result = sum()
  if (at < tokens.length) throw new Error(t('式を読み取れません'))
  return result
}

/** ```figure の SVG で使える要素と属性。これ以外は、表示のときに取り除かれる。 */
export const FIGURE_ELEMENTS = new Set(['svg', 'g', 'line', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'path', 'text', 'tspan', 'defs', 'marker', 'title'])
export const FIGURE_ATTRIBUTES = new Set([
  'xmlns', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'dx', 'dy', 'points', 'd',
  'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'fill-opacity', 'stroke-opacity',
  'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'transform',
  'id', 'marker-start', 'marker-end', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient',
])

/** 属性の値が安全か。外部の読みこみやスクリプトにつながる書き方は通さない（矢印の先などの図の中の参照だけは許す） */
export function safeFigureValue(value: string): boolean {
  if (value.length > 4000 || /[<>]|javascript:|data:|@import|expression\(/i.test(value)) return false
  return !/url\(/i.test(value) || /^url\(#[\w-]+\)$/.test(value.trim())
}
