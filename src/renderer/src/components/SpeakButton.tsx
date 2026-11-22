import { speak, useCanSpeak } from '../lib/speech'
import { t } from '@/lib/i18n'

/** 文章を読み上げる小さなボタン */
export function SpeakButton({ text, lang = 'en-US', label = t('読み上げる') }: { text: string; lang?: string; label?: string }) {
  // その言語の音声が PC に入っていなければ、ボタンを出さない
  if (!useCanSpeak(lang)) return null
  return (
    <button type="button" className="speak" title={label} aria-label={label} onClick={() => void speak(text, lang)}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z M15.5 9a4 4 0 010 6 M18 6.5a7.5 7.5 0 010 11" />
      </svg>
    </button>
  )
}
