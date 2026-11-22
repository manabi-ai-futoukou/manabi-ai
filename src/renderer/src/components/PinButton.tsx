import { useEffect, useState } from 'react'
import { api } from '../lib/hooks'
import { t } from '@/lib/i18n'

type Side = 'left' | 'right'

/**
 * この画面を、右または左に固定するボタン。
 * 固定した画面は、ほかの画面を開いても閉じない（かくれない）。ほかの画面は、反対側に開く。
 * パソコン版では、ウィンドウを画面の右半分・左半分に置く。Web 版では、並べた画面のうちの片方として残す。
 */
export function PinButton({ className = 'btn' }: { className?: string }) {
  const [side, setSide] = useState<Side | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const load = () => void api.view.pinned().then(setSide, () => undefined)
    load()
    return api.onChanged((topic) => topic === 'pin' && load())
  }, [])

  const pin = (next: Side | null) => {
    setOpen(false)
    void api.view.pin(next).then(setSide, () => undefined)
  }

  return (
    <span className="popover-host pin-host">
      <button className={className} aria-expanded={open} aria-pressed={!!side} title={t('この画面を固定する（ほかの画面を開いても、この画面は閉じません）')} onClick={() => setOpen((on) => !on)}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill={side ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9 3h6l-1 6 3 4H7l3-4-1-6z M12 13v8" />
        </svg>
        <span>{side === 'left' ? t('左に固定中') : side === 'right' ? t('右に固定中') : t('固定')}</span>
      </button>
      {open && (
        <div className="popover pin-menu" role="dialog" aria-label={t('画面の固定')}>
          <p className="popover-title">{t('この画面を固定する')}</p>
          <div className="segmented">
            <button aria-pressed={side === 'left'} onClick={() => pin('left')}>{t('左に固定')}</button>
            <button aria-pressed={side === 'right'} onClick={() => pin('right')}>{t('右に固定')}</button>
            <button aria-pressed={!side} onClick={() => pin(null)}>{t('固定しない')}</button>
          </div>
          <p className="muted">{t('固定すると、ほかの画面を開いても、この画面は閉じません。ほかの画面は、反対側に開きます。')}</p>
        </div>
      )}
    </span>
  )
}
