import { useEffect, useState } from 'react'
import type { GraphObject, ImageObject, LinkObject, NoteObject, ShapeObject, TableObject } from '@shared/types'
import { api } from '../lib/hooks'
import { t } from '@/lib/i18n'

/** ページに置く部品（図形・表・座標平面・画像・リンク）の描画と当たり判定 */

export const NOTE_FONT = "'BIZ UDPGothic', 'Yu Gothic UI', 'Meiryo', sans-serif"
const INK = '#2c2a35'
const minus = (n: number) => String(n).replace('-', '−')

/** 左上と幅・高さを、必ず正の向きにそろえる（線や矢印は w・h が負のことがある） */
export function boxOf(object: NoteObject): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(object.x, object.x + object.w),
    y: Math.min(object.y, object.y + object.h),
    w: Math.abs(object.w),
    h: Math.abs(object.h),
  }
}

const isLine = (object: NoteObject): object is ShapeObject =>
  object.type === 'shape' && (object.kind === 'line' || object.kind === 'arrow')

/** 点 (px, py) がその部品の上にあるか */
export function hitObject(object: NoteObject, px: number, py: number): boolean {
  if (isLine(object)) {
    const dx = object.w
    const dy = object.h
    const len = dx * dx + dy * dy
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - object.x) * dx + (py - object.y) * dy) / len))
    return Math.hypot(px - (object.x + t * dx), py - (object.y + t * dy)) <= 28 + object.size
  }
  const box = boxOf(object)
  const pad = 14
  return px >= box.x - pad && px <= box.x + box.w + pad && py >= box.y - pad && py <= box.y + box.h + pad
}

// ───────── 画像の読みこみ ─────────

const loading = new Map<string, Promise<HTMLImageElement | null>>()

/** 取りこんだ画像を読みこむ。同じ画像は 1 回だけ読む。 */
export function loadImage(attachmentId: string): Promise<HTMLImageElement | null> {
  let pending = loading.get(attachmentId)
  if (!pending) {
    pending = api.attachments.data(attachmentId).then(
      (url) =>
        new Promise<HTMLImageElement | null>((resolve) => {
          if (!url) return resolve(null)
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = () => resolve(null)
          image.src = url
        }),
    )
    loading.set(attachmentId, pending)
  }
  return pending
}

export type LoadedImages = Map<string, HTMLImageElement>

export async function loadImagesFor(objects: NoteObject[]): Promise<LoadedImages> {
  const loaded: LoadedImages = new Map()
  await Promise.all(
    objects
      .filter((o): o is ImageObject => o.type === 'image')
      .map(async (o) => {
        const image = await loadImage(o.attachmentId)
        if (image) loaded.set(o.attachmentId, image)
      }),
  )
  return loaded
}

/** ページの部品に含まれる画像を読みこみ、読みこめたら描き直せるように状態として返す */
export function useImages(objects: NoteObject[]): LoadedImages {
  const [images, setImages] = useState<LoadedImages>(new Map())
  const ids = objects.flatMap((o) => (o.type === 'image' ? [o.attachmentId] : [])).join(',')
  useEffect(() => {
    let cancelled = false
    if (!ids) return
    void loadImagesFor(objects).then((loaded) => !cancelled && setImages(loaded))
    return () => {
      cancelled = true
    }
    // objects そのものではなく、画像の ID の並びが変わったときだけ読み直す
  }, [ids])
  return images
}

// ───────── 描画 ─────────

function paintShape(ctx: CanvasRenderingContext2D, shape: ShapeObject): void {
  ctx.strokeStyle = shape.color
  ctx.fillStyle = shape.color
  ctx.lineWidth = shape.size
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const { x, y, w, h } = shape
  ctx.beginPath()
  if (shape.kind === 'rect') {
    const box = boxOf(shape)
    ctx.rect(box.x, box.y, box.w, box.h)
  } else if (shape.kind === 'ellipse') {
    const box = boxOf(shape)
    ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2, 0, 0, Math.PI * 2)
  } else {
    ctx.moveTo(x, y)
    ctx.lineTo(x + w, y + h)
  }
  ctx.stroke()
  if (shape.kind === 'arrow') {
    const angle = Math.atan2(h, w)
    const head = Math.max(34, shape.size * 4.5)
    ctx.beginPath()
    ctx.moveTo(x + w, y + h)
    ctx.lineTo(x + w - head * Math.cos(angle - 0.42), y + h - head * Math.sin(angle - 0.42))
    ctx.lineTo(x + w - head * Math.cos(angle + 0.42), y + h - head * Math.sin(angle + 0.42))
    ctx.closePath()
    ctx.fill()
  }
}

function clippedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, top: number, height: number): void {
  if (!text) return
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, top, maxWidth, height)
  ctx.clip()
  ctx.fillText(text, x, y)
  ctx.restore()
}

export function tableFontSize(table: TableObject): number {
  return Math.max(22, Math.min(42, (Math.abs(table.h) / table.cells.length) * 0.45))
}

function paintTable(ctx: CanvasRenderingContext2D, table: TableObject): void {
  const box = boxOf(table)
  const rows = table.cells.length
  const cols = table.cells[0]?.length ?? 1
  const cw = box.w / cols
  const ch = box.h / rows
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(box.x, box.y, box.w, box.h)
  ctx.strokeStyle = '#55526a'
  ctx.lineWidth = 3
  ctx.beginPath()
  for (let r = 0; r <= rows; r++) {
    ctx.moveTo(box.x, box.y + r * ch)
    ctx.lineTo(box.x + box.w, box.y + r * ch)
  }
  for (let c = 0; c <= cols; c++) {
    ctx.moveTo(box.x + c * cw, box.y)
    ctx.lineTo(box.x + c * cw, box.y + box.h)
  }
  ctx.stroke()
  ctx.fillStyle = INK
  ctx.font = `${tableFontSize(table)}px ${NOTE_FONT}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  table.cells.forEach((row, r) =>
    row.forEach((text, c) => clippedText(ctx, text, box.x + c * cw + 12, box.y + (r + 0.5) * ch, cw - 20, box.y + r * ch, ch)),
  )
}

function paintGraph(ctx: CanvasRenderingContext2D, graph: GraphObject): void {
  const box = boxOf(graph)
  const n = graph.range
  const sx = box.w / (2 * n)
  const sy = box.h / (2 * n)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(box.x, box.y, box.w, box.h)

  // 目もりの線
  ctx.strokeStyle = '#d3dce6'
  ctx.lineWidth = 2
  ctx.beginPath()
  for (let i = -n; i <= n; i++) {
    ctx.moveTo(cx + i * sx, box.y)
    ctx.lineTo(cx + i * sx, box.y + box.h)
    ctx.moveTo(box.x, cy + i * sy)
    ctx.lineTo(box.x + box.w, cy + i * sy)
  }
  ctx.stroke()

  // 軸（先を少しのばして矢印を付ける）
  const over = 26
  ctx.strokeStyle = INK
  ctx.fillStyle = INK
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.moveTo(box.x - 8, cy)
  ctx.lineTo(box.x + box.w + over, cy)
  ctx.moveTo(cx, box.y + box.h + 8)
  ctx.lineTo(cx, box.y - over)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(box.x + box.w + over + 18, cy)
  ctx.lineTo(box.x + box.w + over - 6, cy - 11)
  ctx.lineTo(box.x + box.w + over - 6, cy + 11)
  ctx.closePath()
  ctx.moveTo(cx, box.y - over - 18)
  ctx.lineTo(cx - 11, box.y - over + 6)
  ctx.lineTo(cx + 11, box.y - over + 6)
  ctx.closePath()
  ctx.fill()

  // 目もりの数（混みあうときは 1 つおき）
  const every = n > 6 ? 2 : 1
  const size = Math.max(18, Math.min(26, sx * 0.42))
  ctx.font = `${size}px ${NOTE_FONT}`
  for (let i = -n; i <= n; i++) {
    if (i === 0 || i % every !== 0) continue
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(minus(i), cx + i * sx, cy + 8)
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(minus(i), cx - 9, cy - i * sy)
  }
  ctx.textAlign = 'right'
  ctx.textBaseline = 'top'
  ctx.fillText('O', cx - 9, cy + 8)
  ctx.font = `italic ${size * 1.2}px serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('x', box.x + box.w + over + 24, cy)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.fillText('y', cx, box.y - over - 22)
}

function paintImage(ctx: CanvasRenderingContext2D, image: ImageObject, loaded: LoadedImages): void {
  const box = boxOf(image)
  const picture = loaded.get(image.attachmentId)
  if (picture) {
    ctx.drawImage(picture, box.x, box.y, box.w, box.h)
    return
  }
  // 読みこむまでの間は、場所だけを示しておく
  ctx.fillStyle = '#efece4'
  ctx.fillRect(box.x, box.y, box.w, box.h)
  ctx.fillStyle = '#8b8898'
  ctx.font = `28px ${NOTE_FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(image.name, box.x + box.w / 2, box.y + box.h / 2)
}

export function linkCaption(link: LinkObject): string {
  if (link.kind === 'video') return t('この PC の動画')
  try {
    return new URL(link.target).host
  } catch {
    return link.target
  }
}

function paintLink(ctx: CanvasRenderingContext2D, link: LinkObject): void {
  const box = boxOf(link)
  const video = link.kind === 'video'
  ctx.beginPath()
  ctx.roundRect(box.x, box.y, box.w, box.h, 20)
  ctx.fillStyle = video ? '#f5f1fb' : '#eef6f8'
  ctx.fill()
  ctx.strokeStyle = video ? '#b9aede' : '#a9cdd6'
  ctx.lineWidth = 3
  ctx.stroke()

  // 種類を示す印: 動画は再生の三角、リンクは右上向きの矢印
  const r = Math.min(34, box.h * 0.3)
  const ix = box.x + 28 + r
  const iy = box.y + box.h / 2
  ctx.beginPath()
  ctx.arc(ix, iy, r, 0, Math.PI * 2)
  ctx.fillStyle = video ? '#6557a6' : '#0e86a0'
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 5
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  if (video) {
    ctx.moveTo(ix - r * 0.3, iy - r * 0.45)
    ctx.lineTo(ix + r * 0.5, iy)
    ctx.lineTo(ix - r * 0.3, iy + r * 0.45)
    ctx.closePath()
    ctx.fill()
  } else {
    ctx.moveTo(ix - r * 0.35, iy + r * 0.35)
    ctx.lineTo(ix + r * 0.35, iy - r * 0.35)
    ctx.moveTo(ix - r * 0.1, iy - r * 0.35)
    ctx.lineTo(ix + r * 0.35, iy - r * 0.35)
    ctx.lineTo(ix + r * 0.35, iy + r * 0.1)
    ctx.stroke()
  }

  const tx = ix + r + 22
  const width = box.x + box.w - tx - 20
  ctx.fillStyle = INK
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.font = `bold 32px ${NOTE_FONT}`
  clippedText(ctx, link.title, tx, box.y + box.h * 0.36, width, box.y, box.h)
  ctx.fillStyle = '#5c596b'
  ctx.font = `24px ${NOTE_FONT}`
  clippedText(ctx, linkCaption(link), tx, box.y + box.h * 0.7, width, box.y, box.h)
}

/** ページの部品を、置いた順に描く */
export function paintObjects(ctx: CanvasRenderingContext2D, objects: NoteObject[], images: LoadedImages): void {
  for (const object of objects) {
    ctx.save()
    if (object.type === 'shape') paintShape(ctx, object)
    else if (object.type === 'table') paintTable(ctx, object)
    else if (object.type === 'graph') paintGraph(ctx, object)
    else if (object.type === 'image') paintImage(ctx, object, images)
    else paintLink(ctx, object)
    ctx.restore()
  }
}
