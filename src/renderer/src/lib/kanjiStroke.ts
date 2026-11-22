/**
 * 漢字の書き順の判定。書いた 1 本の線を、手本の線（KanjiVG）とくらべる。
 * 座標は、どちらも 109 × 109 の枠（KANJI_BOX）にそろえて扱う。
 */

export type Point = [number, number]

/** くらべるときに、線を何個の点にそろえるか */
const SAMPLES = 24
const SVG_NS = 'http://www.w3.org/2000/svg'

const hypot = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1])

export function pathLength(d: string): number {
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', d)
  return path.getTotalLength()
}

/** 手本の線（SVG のパス）を、長さにそって等間隔の点にする */
export function samplePath(d: string, count = SAMPLES): Point[] {
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', d)
  const total = path.getTotalLength()
  return Array.from({ length: count }, (_, i) => {
    const p = path.getPointAtLength((total * i) / (count - 1))
    return [p.x, p.y] as Point
  })
}

export function lengthOf(points: Point[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) total += hypot(points[i - 1], points[i])
  return total
}

/** 書いた線を、長さにそって等間隔の点にそろえる */
export function resample(points: Point[], count = SAMPLES): Point[] {
  if (points.length < 2) return Array.from({ length: count }, () => points[0] ?? [0, 0])
  const total = lengthOf(points)
  if (total === 0) return Array.from({ length: count }, () => points[0])
  const out: Point[] = []
  let walked = 0
  let segment = 1
  for (let i = 0; i < count; i++) {
    const target = (total * i) / (count - 1)
    while (segment < points.length - 1 && walked + hypot(points[segment - 1], points[segment]) < target) {
      walked += hypot(points[segment - 1], points[segment])
      segment++
    }
    const a = points[segment - 1]
    const b = points[segment]
    const span = hypot(a, b) || 1
    const t = Math.max(0, Math.min(1, (target - walked) / span))
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
  }
  return out
}

/** 同じ番号の点どうしの距離の平均 */
function gap(a: Point[], b: Point[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += hypot(a[i], b[i])
  return sum / a.length
}

export type StrokeVerdict =
  | { ok: true }
  /** order: 別の画を書いた（書き順ちがい）/ direction: 向きが逆 / shape: 形や位置がちがう */
  | { ok: false; reason: 'order' | 'direction' | 'shape' }

/** 手本とのずれを、ここまでなら同じ線とみなす（枠 109 に対する大きさ） */
const TOLERANCE = 19
/** 書きはじめの位置のずれを、ここまで許す */
const START_TOLERANCE = 30

/**
 * 書いた線が、手本の index 番目の線として正しいかを判定する。
 * @param drawn 書いた線（枠 109 の座標）
 * @param expected 手本の線すべて（samplePath でそろえた点）
 */
export function judgeStroke(drawn: Point[], expected: Point[][], index: number): StrokeVerdict {
  const target = expected[index]
  if (!target || drawn.length < 2) return { ok: false, reason: 'shape' }
  const mine = resample(drawn)
  const wantedLength = lengthOf(target)
  const myLength = lengthOf(drawn)
  // 点のような短い線は、長さのちがいを大目に見る
  const lengthOk = wantedLength < 14 ? myLength < 40 : myLength > wantedLength * 0.4 && myLength < wantedLength * 2.4
  const own = gap(mine, target)

  if (own <= TOLERANCE && lengthOk && hypot(mine[0], target[0]) <= START_TOLERANCE) {
    // 手本の次の画以降に、もっとよく合う線があれば、書き順をまちがえて先の画を書いたとみなす
    for (let j = index + 1; j < expected.length; j++) {
      if (own > 8 && gap(mine, expected[j]) < own * 0.55) return { ok: false, reason: 'order' }
    }
    return { ok: true }
  }
  const reversed = [...mine].reverse()
  if (lengthOk && gap(reversed, target) <= TOLERANCE * 0.8) return { ok: false, reason: 'direction' }
  for (let j = 0; j < expected.length; j++) {
    if (j !== index && gap(mine, expected[j]) <= TOLERANCE * 0.7) return { ok: false, reason: 'order' }
  }
  return { ok: false, reason: 'shape' }
}
