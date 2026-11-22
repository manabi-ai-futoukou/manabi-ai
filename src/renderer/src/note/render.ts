import { getStroke, getStrokeOutlinePoints, getStrokePoints } from 'perfect-freehand'
import { MARGIN_BOTTOM, MARGIN_SIDE, MARGIN_TOP, MM, PAGE_H, PAGE_W, ruleLines } from '@shared/page'
import type { NoteObject, NotePage, Ruling, Stroke, TextBox } from '@shared/types'
import { NOTE_FONT, loadImagesFor, paintObjects, type LoadedImages } from './objects'
import { newId } from '../lib/id'

export { NOTE_FONT }
const RULE_COLOR = '#c9d8e6'
const MARKER_ALPHA = 0.38

// ───────── 線 ─────────

type StrokeStyle = Pick<Stroke, 'tool' | 'size' | 'pressure' | 'baked'>

/** 線の描き方の決まり（マーカーは太さが一定。ペンは筆圧で太さを変える。マウスには筆圧が無いので、速さから擬似的に作る） */
const strokeOptions = (style: StrokeStyle) =>
  style.tool === 'marker'
    ? { size: style.size, thinning: 0, smoothing: 0.5, streamline: 0.4, simulatePressure: false }
    : { size: style.size, thinning: 0.62, smoothing: 0.5, streamline: 0.32, simulatePressure: !style.pressure }

interface StrokePoint {
  point: number[]
  pressure: number
  vector: number[]
  distance: number
  runningLength: number
}

/** 「太さを決めた後の点」（[x, y, 筆圧]）の並びを、輪郭を作る部品が受けとる形にする */
function toStrokePoints(points: number[][]): StrokePoint[] {
  const out: StrokePoint[] = []
  let running = 0
  for (const [x, y, pressure] of points) {
    const prev = out[out.length - 1]
    if (!prev) {
      out.push({ point: [x, y], pressure: pressure ?? 0.5, vector: [1, 1], distance: 0, runningLength: 0 })
      continue
    }
    const dx = prev.point[0] - x
    const dy = prev.point[1] - y
    const distance = Math.hypot(dx, dy)
    if (distance === 0) continue
    running += distance
    out.push({ point: [x, y], pressure: pressure ?? 0.5, vector: [dx / distance, dy / distance], distance, runningLength: running })
  }
  if (out.length) out[0].vector = out[1]?.vector ?? [0, 0]
  return out
}

function outline(points: number[][], style: StrokeStyle, complete: boolean): number[][] {
  // 消しゴムで一部を消した線は、点の位置と太さが決まっているので、そのまま輪郭にする
  if (style.baked) return getStrokeOutlinePoints(toStrokePoints(points) as Parameters<typeof getStrokeOutlinePoints>[0], { ...strokeOptions(style), simulatePressure: false, last: true })
  return getStroke(points, { ...strokeOptions(style), last: complete })
}

/** 輪郭の点の並びを、なめらかな曲線のパスにする */
function toPath(points: number[][]): Path2D {
  const path = new Path2D()
  if (points.length < 2) return path
  path.moveTo(points[0][0], points[0][1])
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[(i + 1) % points.length]
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2)
  }
  path.closePath()
  return path
}

export function draftPath(points: number[][], style: StrokeStyle): Path2D {
  return toPath(outline(points, style, false))
}

/** 書き終えた線のパスは作り直さずに使い回す（線は書き換えないので、オブジェクトをキーにできる） */
const pathCache = new WeakMap<Stroke, Path2D>()

export function strokePath(stroke: Stroke): Path2D {
  let path = pathCache.get(stroke)
  if (!path) {
    path = toPath(outline(stroke.points, stroke, true))
    pathCache.set(stroke, path)
  }
  return path
}

export function paintPath(ctx: CanvasRenderingContext2D, path: Path2D, tool: Stroke['tool'], color: string): void {
  ctx.save()
  if (tool === 'marker') {
    ctx.globalAlpha = MARKER_ALPHA
    ctx.globalCompositeOperation = 'multiply'
  }
  ctx.fillStyle = color
  ctx.fill(path)
  ctx.restore()
}

// ───────── 消しゴムの当たり判定 ─────────

const boundsCache = new WeakMap<Stroke, [number, number, number, number]>()

function bounds(stroke: Stroke): [number, number, number, number] {
  let b = boundsCache.get(stroke)
  if (!b) {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [x, y] of stroke.points) {
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
    b = [x0, y0, x1, y1]
    boundsCache.set(stroke, b)
  }
  return b
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** 点 (x, y) から radius 以内を線が通っているか */
export function hitsStroke(stroke: Stroke, x: number, y: number, radius: number): boolean {
  const reach = radius + stroke.size / 2
  const [x0, y0, x1, y1] = bounds(stroke)
  if (x < x0 - reach || x > x1 + reach || y < y0 - reach || y > y1 + reach) return false
  const pts = stroke.points
  if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= reach
  for (let i = 1; i < pts.length; i++) {
    if (distanceToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= reach) return true
  }
  return false
}

// ───────── 消しゴムで、線の一部だけを消す ─────────
//
// 線は「点の並び」で持っていて、太さは、描くときに筆圧（マウスでは速さ）から決めている。
// 線を途中で切ると、そのままでは残った部分の太さが変わって見えるので、切る前に「太さを決めた後の点」に直す（bake）。
// 直した線（baked）は、その点と太さのまま描くので、消したところ以外の見た目は変わらない。

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1]

/** 線の点を、描くときと同じ計算で「位置と、太さのもとになる筆圧」に直す（perfect-freehand の中の計算と同じ） */
function bake(stroke: Stroke): number[][] {
  const options = strokeOptions(stroke)
  const sp = getStrokePoints(stroke.points, { ...options, last: true }) as StrokePoint[]
  if (!sp.length) return []
  if (!options.simulatePressure) return sp.map((p) => [p.point[0], p.point[1], p.pressure])
  const size = stroke.size
  const simulate = (prev: number, distance: number) => {
    const speed = Math.min(1, distance / size)
    return Math.min(1, prev + (Math.min(1, 1 - speed) - prev) * (speed * 0.275))
  }
  let prev = sp.slice(0, 10).reduce((acc, cur) => (acc + simulate(acc, cur.distance)) / 2, sp[0].pressure)
  const total = sp[sp.length - 1].runningLength
  let prevVector = sp[0].vector
  let sharp = false
  const out: number[][] = []
  for (let n = 0; n < sp.length; n++) {
    const { point, vector, distance, runningLength } = sp[n]
    const last = n === sp.length - 1
    if (!last && total - runningLength < 3) continue
    const pressure = simulate(prev, distance)
    out.push([point[0], point[1], pressure])
    const nextDot = last ? 1 : dot(vector, sp[n + 1].vector)
    const sharpPrev = dot(vector, prevVector) < 0 && !sharp
    const sharpNext = nextDot < 0
    if (sharpPrev || sharpNext) {
      if (sharpNext) sharp = true
      continue
    }
    sharp = false
    if (last) continue
    prev = pressure
    prevVector = vector
  }
  return out
}

const bakedCache = new WeakMap<Stroke, number[][]>()
function bakedPoints(stroke: Stroke): number[][] {
  if (stroke.baked) return stroke.points
  let points = bakedCache.get(stroke)
  if (!points) {
    points = bake(stroke)
    bakedCache.set(stroke, points)
  }
  return points
}

const round1 = (value: number) => Math.round(value * 10) / 10

/**
 * 消しゴム（(ax, ay) から (bx, by) まで動いた、半径 radius の円）が通ったところだけを、線から消す。
 * 線に当たらなければ null。当たったときは、残った部分の線（0 本以上）を返す。
 */
export function eraseStroke(stroke: Stroke, ax: number, ay: number, bx: number, by: number, radius: number): Stroke[] | null {
  // マーカーは太いので、ふちに少し触れただけでは消さない
  const reach = radius + (stroke.tool === 'marker' ? stroke.size / 4 : stroke.size / 2)
  const [x0, y0, x1, y1] = bounds(stroke)
  if (Math.max(ax, bx) < x0 - reach || Math.min(ax, bx) > x1 + reach || Math.max(ay, by) < y0 - reach || Math.min(ay, by) > y1 + reach) return null
  const pts = bakedPoints(stroke)
  if (!pts.length) return null
  const inside = (p: number[]) => distanceToSegment(p[0], p[1], ax, ay, bx, by) <= reach
  const lerp = (p: number[], q: number[], t: number) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, (p[2] ?? 0.5) + ((q[2] ?? 0.5) - (p[2] ?? 0.5)) * t]
  /** p と q のあいだで、消える・残るが入れかわる点（残る側）を、二分して探す */
  const boundary = (p: number[], q: number[], pInside: boolean) => {
    let lo = 0
    let hi = 1
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) / 2
      if (inside(lerp(p, q, mid)) === pInside) lo = mid
      else hi = mid
    }
    return lerp(p, q, pInside ? hi : lo)
  }
  const step = Math.max(1.5, Math.min(reach / 3, 6))
  const runs: number[][][] = []
  let run: number[][] = []
  let hit = false
  let prevPoint = pts[0]
  let prevInside = inside(prevPoint)
  if (prevInside) hit = true
  else run.push(prevPoint)
  for (let i = 1; i < pts.length; i++) {
    const from = pts[i - 1]
    const to = pts[i]
    const pieces = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / step))
    for (let k = 1; k <= pieces; k++) {
      const point = k === pieces ? to : lerp(from, to, k / pieces)
      const nowInside = inside(point)
      if (nowInside !== prevInside) {
        hit = true
        const edge = boundary(prevPoint, point, prevInside)
        if (nowInside) {
          run.push(edge)
          runs.push(run)
          run = []
        } else run = [edge]
      }
      if (!nowInside && k === pieces) run.push(to)
      prevPoint = point
      prevInside = nowInside
    }
  }
  if (run.length) runs.push(run)
  if (!hit) return null
  // ごく短い切れはし（点のように残るもの）は捨てる
  const least = Math.max(2, stroke.size * 0.3)
  const length = (points: number[][]) => points.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) : 0), 0)
  return runs
    .filter((points) => points.length >= 2 && length(points) >= least)
    .map((points) => ({ ...stroke, id: newId(), baked: true, points: points.map(([x, y, p]) => [round1(x), round1(y), Math.round((p ?? 0.5) * 1000) / 1000]) }))
}

// ───────── 罫線 ─────────

/** 英語用の 4 線: 1 行ぶんの高さと、4 本の線の間かく */
export function englishLines(ruling: Ruling): { pitch: number; gap: number; tops: number[] } {
  const gap = (ruling.spacing * MM) / 3
  const pitch = gap * 5
  const tops: number[] = []
  for (let y = MARGIN_TOP; y + gap * 3 <= PAGE_H - MARGIN_BOTTOM; y += pitch) tops.push(y)
  return { pitch, gap, tops }
}

/** 縦書きの行（縦罫）の左端の位置。右から左へ並ぶ。 */
export function verticalColumns(ruling: Ruling): number[] {
  const step = ruling.spacing * MM
  const columns: number[] = []
  for (let x = PAGE_W - MARGIN_SIDE - step; x >= MARGIN_SIDE - 0.5; x -= step) columns.push(x)
  return columns
}

export function paintRuling(ctx: CanvasRenderingContext2D, ruling: Ruling, scale: number): void {
  if (ruling.kind === 'plain') return
  if (ruling.kind === 'english') {
    // 上から 3 本目が、文字の下をそろえる基線。ここだけ色を変えて見分けやすくする
    const { gap, tops } = englishLines(ruling)
    ctx.save()
    ctx.lineWidth = Math.max(1.4, 1 / scale)
    for (const top of tops) {
      for (let i = 0; i < 4; i++) {
        ctx.strokeStyle = i === 2 ? '#e3a3a3' : RULE_COLOR
        ctx.beginPath()
        ctx.moveTo(MARGIN_SIDE, top + gap * i)
        ctx.lineTo(PAGE_W - MARGIN_SIDE, top + gap * i)
        ctx.stroke()
      }
    }
    ctx.restore()
    return
  }
  if (ruling.kind === 'lined' && ruling.vertical) {
    const step = ruling.spacing * MM
    ctx.save()
    ctx.strokeStyle = RULE_COLOR
    ctx.lineWidth = Math.max(1.4, 1 / scale)
    ctx.beginPath()
    for (const x of [...verticalColumns(ruling), PAGE_W - MARGIN_SIDE]) {
      ctx.moveTo(x, MARGIN_TOP)
      ctx.lineTo(x, PAGE_H - MARGIN_BOTTOM)
    }
    ctx.stroke()
    ctx.restore()
    void step
    return
  }
  const step = ruling.spacing * MM
  const lines = ruleLines(ruling.spacing)
  const left = MARGIN_SIDE
  const right = PAGE_W - MARGIN_SIDE
  ctx.save()
  ctx.strokeStyle = RULE_COLOR
  // 縮小表示でも線が消えないよう、画面上で 1 ピクセルは確保する
  ctx.lineWidth = Math.max(1.4, 1 / scale)
  ctx.beginPath()
  for (const y of lines) {
    ctx.moveTo(left, y)
    ctx.lineTo(right, y)
  }
  if (ruling.kind === 'grid') {
    const top = lines[0]
    const bottom = lines[lines.length - 1]
    const count = Math.floor((right - left) / step)
    const offset = left + (right - left - count * step) / 2
    for (let i = 0; i <= count; i++) {
      ctx.moveTo(offset + i * step, top)
      ctx.lineTo(offset + i * step, bottom)
    }
  }
  ctx.stroke()
  ctx.restore()
}

// ───────── 文字 ─────────

/** 英語 4 線での文字の大きさ（線の間隔の何倍か）。小文字がまん中の段に、大文字が上の線の近くまで届く */
const ENGLISH_FONT = 2.3

const baselines = new Map<string, number>()
/** 行の上端から、文字の下をそろえる基線までの距離。実際のフォントの寸法から求める */
function baselineOffset(fontSize: number, lineHeight: number): number {
  const key = `${fontSize}/${lineHeight}`
  let offset = baselines.get(key)
  if (offset === undefined) {
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.font = `${fontSize}px ${NOTE_FONT}`
    const m = ctx.measureText('Hxg')
    const ascent = m.fontBoundingBoxAscent || fontSize * 0.88
    const descent = m.fontBoundingBoxDescent || fontSize * 0.12
    offset = (lineHeight - (ascent + descent)) / 2 + ascent
    baselines.set(key, offset)
  }
  return offset
}

/** キーボードで入力した文字の大きさ。罫線の間に 1 行が収まるようにする。 */
export function textMetrics(ruling: Ruling): { fontSize: number; lineHeight: number } {
  if (ruling.kind === 'english') {
    const { pitch, gap } = englishLines(ruling)
    return { fontSize: gap * ENGLISH_FONT, lineHeight: pitch }
  }
  const lineHeight = (ruling.kind === 'plain' ? 7 : ruling.spacing) * MM
  return { fontSize: lineHeight * 0.6, lineHeight }
}

/** 文字の枠の上端を、罫線の位置にそろえる */
export function snapToRule(y: number, ruling: Ruling): number {
  const { lineHeight } = textMetrics(ruling)
  const snapped = MARGIN_TOP + Math.round((y - MARGIN_TOP) / lineHeight) * lineHeight
  return Math.max(0, Math.min(PAGE_H - MARGIN_BOTTOM - lineHeight, snapped))
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const char of paragraph) {
      if (line && ctx.measureText(line + char).width > maxWidth) {
        lines.push(line)
        line = char
      } else {
        line += char
      }
    }
    lines.push(line)
  }
  return lines
}

function paintTexts(ctx: CanvasRenderingContext2D, texts: TextBox[], ruling: Ruling): void {
  const { fontSize, lineHeight } = textMetrics(ruling)
  ctx.save()
  ctx.font = `${fontSize}px ${NOTE_FONT}`
  ctx.textBaseline = 'middle'
  for (const box of texts) {
    ctx.fillStyle = box.color
    wrap(ctx, box.text, box.width).forEach((line, i) => ctx.fillText(line, box.x, box.y + lineHeight * (i + 0.5)))
  }
  ctx.restore()
}

// ───────── タイピングした文章 ─────────

/** タイピングモードの文章を置く枠と、文字の大きさ・行の送り。罫線の間に 1 行がちょうど収まるようにする。 */
export function typedLayout(ruling: Ruling): { x: number; y: number; width: number; height: number; fontSize: number; lineHeight: number; vertical: boolean } {
  const vertical = ruling.kind === 'lined' && !!ruling.vertical
  if (ruling.kind === 'english') {
    const { pitch, gap, tops } = englishLines(ruling)
    // 文字の下（基線）が、上から 3 本目の線に乗るように行の上端を決める
    const fontSize = gap * ENGLISH_FONT
    const y = MARGIN_TOP + gap * 2 - baselineOffset(fontSize, pitch)
    return { x: MARGIN_SIDE, y, width: PAGE_W - MARGIN_SIDE * 2, height: tops.length * pitch, fontSize, lineHeight: pitch, vertical: false }
  }
  const { fontSize, lineHeight } = textMetrics(ruling)
  if (vertical) {
    const columns = verticalColumns(ruling)
    const left = columns[columns.length - 1] ?? MARGIN_SIDE
    return { x: left, y: MARGIN_TOP, width: PAGE_W - MARGIN_SIDE - left, height: PAGE_H - MARGIN_TOP - MARGIN_BOTTOM, fontSize, lineHeight, vertical }
  }
  const rows = Math.floor((PAGE_H - MARGIN_TOP - MARGIN_BOTTOM) / lineHeight)
  return { x: MARGIN_SIDE, y: MARGIN_TOP, width: PAGE_W - MARGIN_SIDE * 2, height: rows * lineHeight, fontSize, lineHeight, vertical }
}

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * タイピングした文章を描く。縦書きや行の折り返しを画面とまったく同じにするため、
 * 自分で 1 文字ずつ置くのではなく、同じ CSS を当てた HTML を画像にしてから貼る。
 */
async function paintTyped(ctx: CanvasRenderingContext2D, text: string, ruling: Ruling): Promise<void> {
  if (!text.trim()) return
  const box = typedLayout(ruling)
  const style = `margin:0;width:${box.width}px;height:${box.height}px;overflow:hidden;font-family:${NOTE_FONT.replace(/'/g, '')};font-size:${box.fontSize}px;line-height:${box.lineHeight}px;color:#23232b;white-space:pre-wrap;word-break:break-all;${box.vertical ? 'writing-mode:vertical-rl;' : ''}`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${box.width}" height="${box.height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="${style}">${escapeXml(text)}</div></foreignObject></svg>`
  const image = new Image()
  await new Promise<void>((resolve) => {
    image.onload = () => resolve()
    image.onerror = () => resolve()
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })
  if (image.naturalWidth) ctx.drawImage(image, box.x, box.y, box.width, box.height)
}

// ───────── ページ全体 ─────────
//
// 画面では 2 枚の層に分けて描く。
//   紙の層 … 白地・罫線・部品（図形、表、座標平面、画像、リンク）
//   線の層 … ペンとマーカーの線。透明な層にして紙の層に重ねる（乗算）ので、部品の上にも書きこめる

/** 紙の層: 白地・罫線・部品 */
export function paintPaper(
  ctx: CanvasRenderingContext2D,
  ruling: Ruling,
  scale: number,
  objects: NoteObject[],
  images: LoadedImages,
): void {
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  paintRuling(ctx, ruling, scale)
  paintObjects(ctx, objects, images)
  ctx.restore()
}

/** 線の層: いったん透明にしてから、書き終えた線をすべて描く */
export function paintInk(ctx: CanvasRenderingContext2D, strokes: Stroke[], scale: number, clear = true): void {
  ctx.save()
  if (clear) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  }
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  for (const stroke of strokes) paintPath(ctx, strokePath(stroke), stroke.tool, stroke.color)
  ctx.restore()
}

/**
 * ページを PNG 画像にする（PDF 出力と、AI に見せるために使う）。貼った画像の読みこみを待つので非同期。
 * @param options.inkOnly 真なら、キーボードで入力した文字は描かない（手書きの文字起こしに使う。入力した文字は、もう文字なので）
 */
export async function renderPageImage(page: NotePage, ruling: Ruling, widthPx: number, options: { inkOnly?: boolean } = {}): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = widthPx
  canvas.height = Math.round((widthPx * PAGE_H) / PAGE_W)
  const ctx = canvas.getContext('2d')!
  const scale = widthPx / PAGE_W
  const objects = page.objects ?? []
  paintPaper(ctx, ruling, scale, objects, await loadImagesFor(objects))
  paintInk(ctx, page.strokes, scale, false)
  if (!options.inkOnly) {
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    paintTexts(ctx, page.texts, ruling)
    await paintTyped(ctx, page.typed ?? '', ruling)
  }
  return canvas.toDataURL('image/png')
}

export function isBlank(page: NotePage): boolean {
  return page.strokes.length === 0 && !page.texts.some((t) => t.text.trim()) && !page.objects?.length && !page.typed?.trim()
}
