import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MARGIN_SIDE, PAGE_H, PAGE_W } from '@shared/page'
import type { Ruling, TextBox } from '@shared/types'
import { snapToRule, textMetrics } from './render'
import { t } from '@/lib/i18n'

const round = (value: number) => Math.round(value * 10) / 10

/** キーボードで入力した文字の枠。文字の道具を選んでいるときだけ編集・移動できる。 */
export function TextItem({
  box,
  ruling,
  cssScale,
  active,
  autoFocus,
  onChange,
}: {
  box: TextBox
  ruling: Ruling
  cssScale: number
  active: boolean
  autoFocus?: boolean
  /** null は「この枠を消す」 */
  onChange: (patch: Partial<TextBox> | null) => void
}) {
  const [value, setValue] = useState(box.text)
  const [offset, setOffset] = useState<[number, number] | null>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const drag = useRef<{ startX: number; startY: number } | null>(null)
  const { fontSize, lineHeight } = textMetrics(ruling)

  useEffect(() => setValue(box.text), [box.text])
  useEffect(() => {
    if (autoFocus) areaRef.current?.focus()
  }, [autoFocus])
  // 入力した行数に合わせて、枠の高さを伸び縮みさせる
  useLayoutEffect(() => {
    const area = areaRef.current!
    area.style.height = '0px'
    area.style.height = `${area.scrollHeight}px`
  }, [value, cssScale, box.width, lineHeight])

  const commit = () => {
    const text = value.replace(/\s+$/, '')
    if (!text.trim()) onChange(null)
    else if (text !== box.text) onChange({ text })
  }

  const x = box.x + (offset?.[0] ?? 0)
  const y = box.y + (offset?.[1] ?? 0)

  return (
    <div
      className="note-text"
      data-active={active}
      style={{ left: `${(x / PAGE_W) * 100}%`, top: `${(y / PAGE_H) * 100}%`, width: `${(box.width / PAGE_W) * 100}%` }}
    >
      {active && (
        <span
          className="note-text-handle"
          title={t('ドラッグして移動')}
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { startX: e.clientX, startY: e.clientY }
          }}
          onPointerMove={(e) => {
            if (!drag.current) return
            setOffset([(e.clientX - drag.current.startX) / cssScale, (e.clientY - drag.current.startY) / cssScale])
          }}
          onPointerUp={() => {
            if (drag.current && offset) {
              const nextX = Math.max(0, Math.min(PAGE_W - 200, box.x + offset[0]))
              onChange({ x: round(nextX), y: snapToRule(box.y + offset[1], ruling), width: round(Math.min(box.width, PAGE_W - MARGIN_SIDE - nextX)) })
            }
            drag.current = null
            setOffset(null)
          }}
        >
          ⠿
        </span>
      )}
      <textarea
        ref={areaRef}
        value={value}
        readOnly={!active}
        tabIndex={active ? 0 : -1}
        spellCheck={false}
        placeholder={active ? t('ここに入力') : ''}
        style={{ fontSize: `${fontSize * cssScale}px`, lineHeight: `${lineHeight * cssScale}px`, color: box.color }}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
      />
    </div>
  )
}
