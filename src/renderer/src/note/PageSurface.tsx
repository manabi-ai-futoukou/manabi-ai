import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { MARGIN_SIDE, PAGE_H, PAGE_W } from '@shared/page'
import type { NoteObject, NotePage, Ruling, ShapeObject, Stroke, TextBox } from '@shared/types'
import { boxOf, hitObject, paintObjects, useImages } from './objects'
import { recordSample, recordStrokeEnd, recordStrokeStart } from './penStats'
import { draftPath, eraseStroke, hitsStroke, paintInk, paintPaper, paintPath, snapToRule, strokePath, textMetrics, typedLayout } from './render'
import { SelectionBox } from './SelectionBox'
import { TextItem } from './TextItem'
import { useNoTouchScroll } from '../lib/hooks'
import { t } from '@/lib/i18n'
import { newId } from '../lib/id'

export type Tool = 'pen' | 'marker' | 'eraser' | 'text' | 'shape' | 'select'

const NO_IMAGES = new Map<string, HTMLImageElement>()

interface Props {
  page: NotePage
  pageNumber: number
  ruling: Ruling
  tool: Tool
  color: string
  size: number
  /** 消しゴムの半径（1 = 0.1mm）と、消し方（whole が真なら、触れた線を 1 本まるごと消す。偽なら、通ったところだけを消す） */
  eraser: { radius: number; whole: boolean }
  /** 図形の道具で描く形 */
  shapeKind: ShapeObject['kind']
  /** 選択の道具で、範囲を囲む形（四角か、投げなわ） */
  region: 'rect' | 'lasso'
  /** タイピングモード（罫線に沿ってキーボードで入力する。ペンでは書かない） */
  typing: boolean
  /** 指でも書けるようにする（ペンの無いスマートフォン向け。ふだんは、手のひらが触れても線にならないよう、指では書かない） */
  touch?: boolean
  /** ページをつかんで動かしている最中（書きこみを受けつけない） */
  locked: boolean
  /** 選んでいる部品（どのページのものでも、ノート全体で 1 つ） */
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** このページに触れた（Delete キーなどの対象になる） */
  onActivate: () => void
  /** ページの内容が変わったとき（線を 1 本書き終えた、消した、文字や部品を確定した） */
  onCommit: (next: NotePage) => void
  onNotice: (text: string) => void
}

/** いま書いている途中の線・図形、消しゴム、範囲の指定、選んだものの移動 */
interface Draft {
  pointerId: number
  mode: 'draw' | 'erase' | 'shape' | 'region' | 'move'
  tool: 'pen' | 'marker'
  color: string
  size: number
  points: number[][]
  pressure: boolean
  rect: DOMRect
  /** 消しゴム: まだ残っている線 */
  strokes: Stroke[]
  changed: boolean
  cursor: [number, number] | null
  /** 図形・範囲・移動: はじめの点と、いまの点 */
  from: [number, number]
  to: [number, number]
}

/** 範囲選択で選ばれているもの */
interface Group {
  strokes: Set<string>
  texts: Set<string>
  objects: Set<string>
}

const round = (value: number) => Math.round(value * 10) / 10

/** 点が多角形の中にあるか（投げなわの判定） */
function inside(polygon: number[][], x: number, y: number): boolean {
  let hit = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/**
 * ノートの 1 ページ。ペン・マウスの入力を受けて線を描く。
 *
 * 重ねている層は下から順に、
 *   (1) 紙の層: 白地・罫線・部品（図形、表、座標平面、画像、リンク）
 *   (2) タイピングした文章
 *   (3) 線の層: 書き終えた線。透明な層を乗算で重ねるので、部品や文章の上にも書きこめる
 *   (4) 書いている途中の線や図形、範囲の枠
 *   (5) 文字の枠、選んだものを操作する枠
 */
export function PageSurface(props: Props) {
  const { page, pageNumber, ruling, tool, color, size, eraser, shapeKind, region, typing, touch, locked, selectedId, onSelect, onActivate, onCommit, onNotice } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const paperRef = useRef<HTMLCanvasElement>(null)
  const inkRef = useRef<HTMLCanvasElement>(null)
  const liveRef = useRef<HTMLCanvasElement>(null)
  // 指で書けるとき（スマートフォン）: 文字の道具とタイピングのあいだは、欄に触れて入力できるよう、指の動きを止めない
  useNoTouchScroll(hostRef, !!touch && !typing && tool !== 'text')
  const draft = useRef<Draft | null>(null)
  /** 消しゴムを持って、紙の上にペンやマウスがあるときの位置（消える範囲の円を見せる） */
  const hover = useRef<[number, number] | null>(null)
  const frame = useRef(0)
  const pageRef = useRef(page)
  pageRef.current = page
  const [box, setBox] = useState({ width: 0, height: 0 })
  const [pending, setPending] = useState<TextBox | null>(null)
  /** 動かしている途中の部品（確定前の姿） */
  const [moving, setMoving] = useState<NoteObject | null>(null)
  const [group, setGroup] = useState<Group | null>(null)
  const groupRef = useRef(group)
  groupRef.current = group

  const objects = page.objects ?? []
  const images = useImages(objects)
  const shown = moving ? objects.map((o) => (o.id === moving.id ? moving : o)) : objects
  const selected = tool === 'select' && !group ? shown.find((o) => o.id === selectedId) : undefined

  useLayoutEffect(() => {
    const host = hostRef.current!
    const measure = () => setBox({ width: host.clientWidth, height: host.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  // 大きく拡大しても描く画像が大きくなりすぎないよう、1 ページの横幅を 4096 画素までにおさえる（それ以上は、少し粗く表示される）
  const dpr = Math.min(window.devicePixelRatio || 1, 4096 / Math.max(1, box.width))
  const pixelW = Math.round(box.width * dpr)
  const pixelH = Math.round(box.height * dpr)
  const scale = pixelW / PAGE_W

  useLayoutEffect(() => {
    if (!pixelW || !pixelH) return
    for (const canvas of [paperRef.current!, inkRef.current!, liveRef.current!]) {
      if (canvas.width !== pixelW || canvas.height !== pixelH) {
        canvas.width = pixelW
        canvas.height = pixelH
      }
    }
  }, [pixelW, pixelH])

  useLayoutEffect(() => {
    if (pixelW && pixelH) paintPaper(paperRef.current!.getContext('2d')!, ruling, scale, shown, images)
    // shown は毎回作り直す配列なので、中身のもと（objects と moving）で判断する
  }, [page.objects, moving, images, ruling, pixelW, pixelH, scale])

  useLayoutEffect(() => {
    if (pixelW && pixelH) paintInk(inkRef.current!.getContext('2d')!, page.strokes, scale)
  }, [page.strokes, pixelW, pixelH, scale])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  // 道具を持ちかえたら、範囲選択は解く
  useEffect(() => setGroup(null), [tool, typing])
  useEffect(() => {
    if (tool !== 'eraser' || typing) hover.current = null
    schedule()
  }, [tool, typing, eraser.radius])

  /** 範囲選択で選んだものを囲む四角 */
  const groupBounds = (g: Group) => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    const grow = (x: number, y: number) => {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
    for (const s of page.strokes) if (g.strokes.has(s.id)) for (const [x, y] of s.points) grow(x, y)
    for (const t of page.texts) {
      if (!g.texts.has(t.id)) continue
      grow(t.x, t.y)
      grow(t.x + Math.min(t.width, 600), t.y + textMetrics(ruling).lineHeight)
    }
    for (const o of objects) {
      if (!g.objects.has(o.id)) continue
      const b = boxOf(o)
      grow(b.x, b.y)
      grow(b.x + b.w, b.y + b.h)
    }
    return x0 === Infinity ? null : { x: x0 - 20, y: y0 - 20, w: x1 - x0 + 40, h: y1 - y0 + 40 }
  }
  const bounds = group ? groupBounds(group) : null

  /** 選んだもの（1 つの部品、または範囲選択）を消す */
  const removeSelection = () => {
    const current = pageRef.current
    const g = groupRef.current
    if (g) {
      setGroup(null)
      onCommit({
        ...current,
        strokes: current.strokes.filter((s) => !g.strokes.has(s.id)),
        texts: current.texts.filter((t) => !g.texts.has(t.id)),
        objects: (current.objects ?? []).filter((o) => !g.objects.has(o.id)),
      })
    } else if (selected) {
      onSelect(null)
      onCommit({ ...current, objects: (current.objects ?? []).filter((o) => o.id !== selected.id) })
    }
  }
  const removeRef = useRef(removeSelection)
  removeRef.current = removeSelection
  const hasSelection = !!group || !!selected
  useEffect(() => {
    if (!hasSelection) return
    // ノート全体の Delete（そのページを全部消す）より先に受けとって、選んだものだけを消す
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        e.stopImmediatePropagation()
        removeRef.current()
      } else if (e.key === 'Escape') setGroup(null)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [hasSelection])

  // 低遅延描画（desynchronized: true）は使わない。指定すると、この層が画面合成を通らずに直接表示され、
  // GPU と画面の組み合わせによっては透明な部分が黒で表示されて、ページ全体が真っ黒になる。
  // アプリ内の画面写真には写らず、実際の画面でしか起きないので、確認は scripts/smoke.mjs の実画面取り込みで行う。
  const liveContext = () => liveRef.current!.getContext('2d')!

  const shapeFrom = (d: Draft): ShapeObject => ({
    id: 'draft',
    type: 'shape',
    kind: shapeKind,
    x: d.from[0],
    y: d.from[1],
    w: round(d.to[0] - d.from[0]),
    h: round(d.to[1] - d.from[1]),
    color: d.color,
    size: d.size,
  })

  const paintLive = () => {
    frame.current = 0
    const ctx = liveContext()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    const d = draft.current
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    const ring = (at: [number, number], pressed: boolean) => {
      ctx.beginPath()
      ctx.arc(at[0], at[1], eraser.radius, 0, Math.PI * 2)
      ctx.fillStyle = pressed ? 'rgba(120, 130, 150, 0.18)' : 'rgba(120, 130, 150, 0.08)'
      ctx.strokeStyle = 'rgba(90, 100, 120, 0.7)'
      ctx.lineWidth = 2 / scale
      ctx.fill()
      ctx.stroke()
    }
    if (!d) {
      // 消しゴムを持っているあいだは、押す前から、消える範囲の円を見せる
      if (hover.current && tool === 'eraser' && !typing && !locked) ring(hover.current, false)
      return
    }
    if (d.mode === 'draw') {
      if (d.points.length) paintPath(ctx, draftPath(d.points, d), d.tool, d.color)
    } else if (d.mode === 'shape') {
      paintObjects(ctx, [shapeFrom(d)], NO_IMAGES)
    } else if (d.mode === 'region') {
      // 範囲の枠（四角、または投げなわの軌跡）
      ctx.beginPath()
      if (region === 'rect') ctx.rect(d.from[0], d.from[1], d.to[0] - d.from[0], d.to[1] - d.from[1])
      else d.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      ctx.fillStyle = 'rgba(61, 138, 92, 0.1)'
      ctx.strokeStyle = '#3d8a5c'
      ctx.lineWidth = 2.5 / scale
      ctx.fill()
      ctx.stroke()
    } else if (d.mode === 'move') {
      // 選んだ線を、動かした先に描く（もとの位置の線は、線の層から外してある）
      const g = groupRef.current
      ctx.translate(d.to[0] - d.from[0], d.to[1] - d.from[1])
      for (const s of pageRef.current.strokes) if (g?.strokes.has(s.id)) paintPath(ctx, strokePath(s), s.tool, s.color)
    } else if (d.cursor) ring(d.cursor, true)
  }
  const schedule = () => {
    if (!frame.current) frame.current = requestAnimationFrame(paintLive)
  }

  /** 1 回の通知にまとめられた細かい座標も、すべて取り出して線に加える */
  const extend = (native: PointerEvent) => {
    const d = draft.current
    if (!d) return
    let merged = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : []
    // まとめられた座標の最後は、いまの通知と同じ位置のはず。ずれているときは、座標の基準がちがう（ブラウザの不具合）ので使わない
    const tail = merged[merged.length - 1]
    if (tail && (Math.abs(tail.clientX - native.clientX) > 4 || Math.abs(tail.clientY - native.clientY) > 4)) merged = []
    for (const ev of merged.length ? merged : [native]) {
      recordSample(ev, true)
      const x = round(((ev.clientX - d.rect.left) / d.rect.width) * PAGE_W)
      const y = round(((ev.clientY - d.rect.top) / d.rect.height) * PAGE_H)
      if (d.mode === 'shape' || d.mode === 'move' || d.mode === 'region') {
        d.to = [x, y]
        if (d.mode === 'region') d.points.push([x, y])
      } else if (d.mode === 'erase') {
        // 前の位置からいまの位置まで、消しゴムが通ったところを消す（速く動かしても、あいだが抜けない）
        const [fromX, fromY] = d.cursor ?? [x, y]
        d.cursor = [x, y]
        let changed = false
        if (eraser.whole) {
          const kept = d.strokes.filter((s) => !hitsStroke(s, x, y, eraser.radius))
          changed = kept.length !== d.strokes.length
          if (changed) d.strokes = kept
        } else {
          const next: Stroke[] = []
          for (const s of d.strokes) {
            const rest = eraseStroke(s, fromX, fromY, x, y, eraser.radius)
            if (rest) changed = true
            if (rest) next.push(...rest)
            else next.push(s)
          }
          if (changed) d.strokes = next
        }
        if (changed) {
          d.changed = true
          paintInk(inkRef.current!.getContext('2d')!, d.strokes, scale)
        }
      } else {
        const last = d.points[d.points.length - 1]
        const pressure = d.pressure ? (ev.pressure > 0 ? ev.pressure : (last?.[2] ?? 0.5)) : 0.5
        d.points.push([x, y, Math.round(pressure * 1000) / 1000])
      }
    }
    schedule()
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    recordSample(e.nativeEvent, false)
    onActivate()
    // 紙に触れたら、キー操作がこのノートに届くようにする。
    // 下で「既定の動き」を止めるので、そのままだと、入力の位置が前の場所（題名の欄や、Web 版ではとなりの画面）に残り、
    // 書いた直後にショートカットキーが効かなくなる（上のメニューを押すまで効かなかった原因）。
    const field = (el: Element | null) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
    if (!typing && !field(e.target as Element)) {
      const active = document.activeElement
      if (active instanceof HTMLElement && active !== document.body && field(active) && !e.currentTarget.contains(active)) active.blur()
      if (!field(document.activeElement)) e.currentTarget.focus({ preventScroll: true })
    }
    // 指や手のひらでは書かない（ペンで書いているときに手が触れても線にならないようにする）
    if (locked || typing || (e.pointerType === 'touch' && !touch) || draft.current) return
    // ペンの後ろ側（消しゴム）は、選んでいる道具に関係なく消しゴムとして働く
    const penEraser = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0)
    if (e.button !== 0 && !penEraser) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * PAGE_W
    const py = ((e.clientY - rect.top) / rect.height) * PAGE_H
    let mode: Draft['mode'] = penEraser || tool === 'eraser' ? 'erase' : tool === 'shape' ? 'shape' : 'draw'

    if (tool === 'select' && !penEraser) {
      const b = groupRef.current && groupBounds(groupRef.current)
      if (b && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
        // 範囲選択の中をつかんだ: 選んだものを動かす。動かす線は、いったん線の層から外す
        mode = 'move'
        paintInk(inkRef.current!.getContext('2d')!, pageRef.current.strokes.filter((s) => !groupRef.current!.strokes.has(s.id)), scale)
      } else {
        // 上に重なっている（後から置いた）部品を優先して選ぶ。何も無い所なら、範囲の指定を始める
        const hit = [...objects].reverse().find((o) => hitObject(o, px, py))
        setGroup(null)
        onSelect(hit?.id ?? null)
        if (hit) return
        mode = 'region'
      }
    } else if (tool === 'text' && !penEraser) {
      if ((e.target as HTMLElement).closest('.note-text')) return
      const x = Math.max(MARGIN_SIDE, Math.min(PAGE_W - MARGIN_SIDE - 300, px))
      const y = snapToRule(py - textMetrics(ruling).lineHeight / 2, ruling)
      e.preventDefault()
      setPending({ id: newId(), x: round(x), y, width: round(PAGE_W - MARGIN_SIDE - x), text: '', color })
      return
    }

    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // 自動確認が作る擬似的な入力では捕捉できないが、描画には影響しない
    }
    draft.current = {
      pointerId: e.pointerId,
      mode,
      tool: tool === 'marker' ? 'marker' : 'pen',
      color,
      size,
      points: [],
      pressure: e.pointerType === 'pen',
      rect,
      strokes: pageRef.current.strokes,
      changed: false,
      cursor: null,
      from: [round(px), round(py)],
      to: [round(px), round(py)],
    }
    recordStrokeStart()
    extend(e.nativeEvent)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (draft.current?.pointerId === e.pointerId) return extend(e.nativeEvent)
    recordSample(e.nativeEvent, false)
    if (tool !== 'eraser' || typing || e.pointerType === 'touch') return
    const rect = e.currentTarget.getBoundingClientRect()
    hover.current = [((e.clientX - rect.left) / rect.width) * PAGE_W, ((e.clientY - rect.top) / rect.height) * PAGE_H]
    schedule()
  }
  const onPointerLeave = () => {
    if (!hover.current) return
    hover.current = null
    schedule()
  }

  /** 範囲（四角または投げなわ）に入っているものを選ぶ。線は、点の 6 割以上が入っていれば選ぶ。 */
  const pick = (d: Draft): Group | null => {
    const [x0, x1] = [Math.min(d.from[0], d.to[0]), Math.max(d.from[0], d.to[0])]
    const [y0, y1] = [Math.min(d.from[1], d.to[1]), Math.max(d.from[1], d.to[1])]
    const within = region === 'rect' ? (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1 : (x: number, y: number) => inside(d.points, x, y)
    const current = pageRef.current
    const g: Group = {
      strokes: new Set(current.strokes.filter((s) => s.points.filter(([x, y]) => within(x, y)).length >= s.points.length * 0.6).map((s) => s.id)),
      texts: new Set(current.texts.filter((t) => within(t.x + 10, t.y + 10)).map((t) => t.id)),
      objects: new Set(
        (current.objects ?? [])
          .filter((o) => {
            const b = boxOf(o)
            return within(b.x + b.w / 2, b.y + b.h / 2)
          })
          .map((o) => o.id),
      ),
    }
    return g.strokes.size + g.texts.size + g.objects.size ? g : null
  }

  // 2 本めの指が触れたとき（指のジェスチャーの始まり）は、書きかけの線を、ページに入れずに捨てる
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const discard = () => {
      if (!draft.current) return
      draft.current = null
      schedule()
      const ink = inkRef.current?.getContext('2d')
      if (ink) paintInk(ink, pageRef.current.strokes, scale)
    }
    host.addEventListener('note-discard', discard)
    return () => host.removeEventListener('note-discard', discard)
  })

  const finish = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = draft.current
    if (!d || d.pointerId !== e.pointerId) return
    draft.current = null
    recordStrokeEnd(d.mode === 'erase')
    if (d.mode === 'erase' && d.cursor && e.type !== 'pointercancel') hover.current = d.cursor
    schedule()
    const current = pageRef.current
    if (d.mode === 'erase') {
      if (d.changed) onCommit({ ...current, strokes: d.strokes })
      return
    }
    if (d.mode === 'region') {
      setGroup(pick(d))
      return
    }
    if (d.mode === 'move') {
      const g = groupRef.current
      const dx = round(d.to[0] - d.from[0])
      const dy = round(d.to[1] - d.from[1])
      if (!g || (dx === 0 && dy === 0)) {
        paintInk(inkRef.current!.getContext('2d')!, current.strokes, scale)
        return
      }
      onCommit({
        ...current,
        strokes: current.strokes.map((s) => (g.strokes.has(s.id) ? { ...s, points: s.points.map(([x, y, p]) => [round(x + dx), round(y + dy), p]) } : s)),
        texts: current.texts.map((t) => (g.texts.has(t.id) ? { ...t, x: round(t.x + dx), y: round(t.y + dy) } : t)),
        objects: (current.objects ?? []).map((o) => (g.objects.has(o.id) ? { ...o, x: round(o.x + dx), y: round(o.y + dy) } : o)),
      })
      return
    }
    if (d.mode === 'shape') {
      const shape = shapeFrom(d)
      // ほとんど動かしていないクリックは、図形にしない
      if (Math.hypot(shape.w, shape.h) < 20) return
      onCommit({ ...current, objects: [...(current.objects ?? []), { ...shape, id: newId() }] })
      return
    }
    if (!d.points.length) return
    const stroke: Stroke = { id: newId(), tool: d.tool, color: d.color, size: d.size, points: d.points, pressure: d.pressure }
    // 途中の線を消す前に、確定した線を線の層へ描いておく（一瞬消えて見えるのを防ぐ）
    const ctx = inkRef.current!.getContext('2d')!
    ctx.save()
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    paintPath(ctx, strokePath(stroke), stroke.tool, stroke.color)
    ctx.restore()
    onCommit({ ...current, strokes: [...current.strokes, stroke] })
  }

  const cssScale = box.width / PAGE_W
  const updateText = (id: string, patch: Partial<TextBox> | null) => {
    const current = pageRef.current
    const texts = patch ? current.texts.map((t) => (t.id === id ? { ...t, ...patch } : t)) : current.texts.filter((t) => t.id !== id)
    onCommit({ ...current, texts })
  }
  const updateObject = (next: NoteObject) => {
    const current = pageRef.current
    onCommit({ ...current, objects: (current.objects ?? []).map((o) => (o.id === next.id ? next : o)) })
  }
  const percent = (value: number, whole: number) => `${(value / whole) * 100}%`

  return (
    <div
      ref={hostRef}
      className="note-page"
      data-tool={typing ? 'typing' : tool}
      data-page={pageNumber}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      <canvas ref={paperRef} className="note-layer" />
      <TypedLayer page={page} ruling={ruling} cssScale={cssScale} typing={typing} onFocus={onActivate} onCommit={(typed) => onCommit({ ...pageRef.current, typed })} />
      <canvas ref={inkRef} className="note-layer note-layer-ink" />
      <canvas ref={liveRef} className="note-layer note-layer-ink" />
      {page.texts.map((text) => (
        <TextItem key={text.id} box={text} ruling={ruling} cssScale={cssScale} active={tool === 'text' && !typing} onChange={(patch) => updateText(text.id, patch)} />
      ))}
      {pending && (
        <TextItem
          key={pending.id}
          box={pending}
          ruling={ruling}
          cssScale={cssScale}
          active
          autoFocus
          onChange={(patch) => {
            setPending(null)
            if (patch?.text) onCommit({ ...pageRef.current, texts: [...pageRef.current.texts, { ...pending, ...patch }] })
          }}
        />
      )}
      {selected && (
        <SelectionBox key={selected.id} object={selected} cssScale={cssScale} onLive={setMoving} onCommit={updateObject} onDelete={removeSelection} onNotice={onNotice} />
      )}
      {bounds && (
        <div
          className="note-group"
          title={t('ドラッグで移動、Delete キーで消す')}
          style={{ left: percent(bounds.x, PAGE_W), top: percent(bounds.y, PAGE_H), width: percent(bounds.w, PAGE_W), height: percent(bounds.h, PAGE_H) }}
        />
      )}
      <span className="note-page-number">{pageNumber}</span>
    </div>
  )
}

/**
 * タイピングモードで入力する文章。罫線の間に 1 行が収まる大きさで、ページいっぱいの入力欄を重ねる。
 * 手書きモードの間は読むだけにして、上からペンで書きこめるようにする。
 */
function TypedLayer({
  page,
  ruling,
  cssScale,
  typing,
  onFocus,
  onCommit,
}: {
  page: NotePage
  ruling: Ruling
  cssScale: number
  typing: boolean
  onFocus: () => void
  onCommit: (typed: string) => void
}) {
  const [value, setValue] = useState(page.typed ?? '')
  const saved = useRef(page.typed ?? '')
  const timer = useRef<number>(undefined)
  const latest = useRef({ value, onCommit })
  latest.current = { value, onCommit }

  // 元に戻す・やり直すなどで、外から内容が変わったときに合わせる
  useEffect(() => {
    if ((page.typed ?? '') !== saved.current) {
      saved.current = page.typed ?? ''
      setValue(saved.current)
    }
  }, [page.typed])

  const commit = () => {
    window.clearTimeout(timer.current)
    const { value: text, onCommit: save } = latest.current
    if (text === saved.current) return
    saved.current = text
    save(text)
  }
  // 入力のたびに履歴を増やさないよう、少し手が止まったときと、欄を離れたときに確定する
  const change = (text: string) => {
    setValue(text)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(commit, 900)
  }
  useEffect(() => () => commit(), [])

  if (!typing && !value) return null
  const box = typedLayout(ruling)
  return (
    <textarea
      className="note-typed"
      data-vertical={box.vertical}
      value={value}
      readOnly={!typing}
      tabIndex={typing ? 0 : -1}
      spellCheck={false}
      aria-label={t('{0}本文', ruling.vertical ? t('縦書きの') : '')}
      placeholder={typing ? t('ここに入力') : ''}
      style={{
        left: `${(box.x / PAGE_W) * 100}%`,
        top: `${(box.y / PAGE_H) * 100}%`,
        width: `${(box.width / PAGE_W) * 100}%`,
        height: `${(box.height / PAGE_H) * 100}%`,
        fontSize: `${box.fontSize * cssScale}px`,
        lineHeight: `${box.lineHeight * cssScale}px`,
      }}
      onFocus={onFocus}
      onChange={(e) => change(e.target.value)}
      onBlur={commit}
    />
  )
}
