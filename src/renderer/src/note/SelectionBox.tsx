import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { PAGE_H, PAGE_W } from '@shared/page'
import type { NoteObject, TableObject } from '@shared/types'
import { api, errorMessage } from '../lib/hooks'
import { boxOf, tableFontSize } from './objects'
import { t } from '@/lib/i18n'

const MIN_SIZE = 60
const round = (value: number) => Math.round(value * 10) / 10

/**
 * 選んだ部品のまわりに出る枠。つかんで動かす、角をつまんで大きさを変える、消す、
 * 表なら文字を書きこむ・行や列を増減する、リンクなら開く、といった操作をここで受ける。
 * 部品そのものの絵は紙の層（canvas）が描くので、ここは操作のための透明な枠だけを持つ。
 */
export function SelectionBox({
  object,
  cssScale,
  onLive,
  onCommit,
  onDelete,
  onNotice,
}: {
  object: NoteObject
  /** ページ座標 1 あたりの画面上のピクセル数 */
  cssScale: number
  /** 動かしている途中の姿（まだ確定しない） */
  onLive: (object: NoteObject | null) => void
  onCommit: (object: NoteObject) => void
  onDelete: () => void
  onNotice: (text: string) => void
}) {
  const box = boxOf(object)
  const line = object.type === 'shape' && (object.kind === 'line' || object.kind === 'arrow')

  /** つかんで動かす操作の共通部分。apply は「動かした量 → 新しい姿」。 */
  const drag = (e: ReactPointerEvent<HTMLElement>, apply: (dx: number, dy: number) => NoteObject) => {
    e.preventDefault()
    e.stopPropagation()
    const element = e.currentTarget
    element.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startY = e.clientY
    let latest: NoteObject | null = null
    const move = (ev: PointerEvent) => {
      latest = apply((ev.clientX - startX) / cssScale, (ev.clientY - startY) / cssScale)
      onLive(latest)
    }
    const end = () => {
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', end)
      element.removeEventListener('pointercancel', end)
      onLive(null)
      if (latest) onCommit(latest)
    }
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', end)
    element.addEventListener('pointercancel', end)
  }

  const move = (e: ReactPointerEvent<HTMLElement>) =>
    drag(e, (dx, dy) => ({
      ...object,
      x: round(Math.max(-box.w + 60, Math.min(PAGE_W - 60, object.x + dx))),
      y: round(Math.max(-box.h + 60, Math.min(PAGE_H - 60, object.y + dy))),
    }))

  const resize = (e: ReactPointerEvent<HTMLElement>) =>
    drag(e, (dx, dy) => {
      // 線と矢印は、終点を動かす
      if (line) return { ...object, w: round(object.w + dx), h: round(object.h + dy) }
      // 画像は縦横の比を保ち、座標平面は正方形のままにする
      if (object.type === 'image') {
        const scale = Math.max(MIN_SIZE / box.w, (box.w + dx) / box.w)
        return { ...object, x: box.x, y: box.y, w: round(box.w * scale), h: round(box.h * scale) }
      }
      if (object.type === 'graph') {
        const side = round(Math.max(300, box.w + Math.max(dx, dy)))
        return { ...object, x: box.x, y: box.y, w: side, h: side }
      }
      return { ...object, x: box.x, y: box.y, w: round(Math.max(MIN_SIZE, box.w + dx)), h: round(Math.max(MIN_SIZE, box.h + dy)) }
    })

  const open = () => {
    if (object.type !== 'link') return
    void api.attachments.open(object.kind, object.target).catch((e) => onNotice(errorMessage(e)))
  }

  return (
    <div
      className="note-select"
      data-kind={object.type}
      style={{
        left: `${(box.x / PAGE_W) * 100}%`,
        top: `${(box.y / PAGE_H) * 100}%`,
        width: `${(Math.max(box.w, 1) / PAGE_W) * 100}%`,
        height: `${(Math.max(box.h, 1) / PAGE_H) * 100}%`,
      }}
      // 表は中のマスに文字を書くので、枠の中をつかんでも動かさない（左上のつまみで動かす）
      onPointerDown={object.type === 'table' ? undefined : move}
    >
      <div className="note-select-bar" onPointerDown={(e) => e.stopPropagation()}>
        <span className="note-select-grip" title={t('ドラッグして移動')} onPointerDown={move}>{t('⠿ 移動')}</span>
        {object.type === 'link' && <button onClick={open}>{t('開く')}</button>}
        {object.type === 'table' && <TableButtons table={object} onCommit={onCommit} />}
        <button onClick={onDelete}>{t('消す')}</button>
      </div>

      {object.type === 'table' && <TableCells table={object} cssScale={cssScale} onLive={onLive} onCommit={onCommit} />}

      <span
        className="note-select-handle"
        title={t('ドラッグして大きさを変える')}
        style={line ? { left: object.w >= 0 ? '100%' : '0%', top: object.h >= 0 ? '100%' : '0%' } : { left: '100%', top: '100%' }}
        onPointerDown={resize}
      />
    </div>
  )
}

/** 表の行と列を増やす・減らす */
function TableButtons({ table, onCommit }: { table: TableObject; onCommit: (object: NoteObject) => void }) {
  const rows = table.cells.length
  const cols = table.cells[0]?.length ?? 1
  const box = boxOf(table)
  // 行や列を増減しても、1 マスの大きさは変えない
  const resizeTo = (cells: string[][]) =>
    onCommit({ ...table, cells, w: round((box.w / cols) * cells[0].length), h: round((box.h / rows) * cells.length) })
  return (
    <>
      <button disabled={rows >= 12} onClick={() => resizeTo([...table.cells, Array<string>(cols).fill('')])}>{t('行＋')}</button>
      <button disabled={rows <= 1} onClick={() => resizeTo(table.cells.slice(0, -1))}>{t('行−')}</button>
      <button disabled={cols >= 8} onClick={() => resizeTo(table.cells.map((row) => [...row, '']))}>{t('列＋')}</button>
      <button disabled={cols <= 1} onClick={() => resizeTo(table.cells.map((row) => row.slice(0, -1)))}>{t('列−')}</button>
    </>
  )
}

/** 表のマスに重ねる入力欄。入力中の文字は紙の層にもすぐ反映し、欄を離れたときに確定する。 */
function TableCells({
  table,
  cssScale,
  onLive,
  onCommit,
}: {
  table: TableObject
  cssScale: number
  onLive: (object: NoteObject | null) => void
  onCommit: (object: NoteObject) => void
}) {
  const [cells, setCells] = useState(table.cells)
  useEffect(() => setCells(table.cells), [table.cells])
  const cols = table.cells[0]?.length ?? 1
  // 入力中は table 自体も「途中の姿」に差しかわるので、変更の有無は中身の比較ではなく印で覚える
  const dirty = useRef(false)

  const change = (r: number, c: number, value: string) => {
    const next = cells.map((row, ri) => (ri === r ? row.map((cell, ci) => (ci === c ? value : cell)) : row))
    dirty.current = true
    setCells(next)
    onLive({ ...table, cells: next })
  }
  const commit = () => {
    onLive(null)
    if (!dirty.current) return
    dirty.current = false
    onCommit({ ...table, cells })
  }

  return (
    <div className="note-table-cells" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, fontSize: `${tableFontSize(table) * cssScale}px` }}>
      {cells.map((row, r) =>
        row.map((cell, c) => (
          <input
            key={`${r}-${c}`}
            value={cell}
            maxLength={60}
            spellCheck={false}
            aria-label={t('{0} 行 {1} 列', r + 1, c + 1)}
            style={{ paddingLeft: `${12 * cssScale}px` }}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => change(r, c, e.target.value)}
            onBlur={commit}
          />
        )),
      )}
    </div>
  )
}
