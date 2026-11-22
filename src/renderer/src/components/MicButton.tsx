import { useEffect, useRef, useState } from 'react'
import { api, errorMessage, useLoad } from '../lib/hooks'
import { Recorder } from '../lib/recorder'
import { SpeechSetup } from './SpeechSetup'
import { getLang, t } from '@/lib/i18n'

/** 1 回に録音できる長さ（秒） */
const MAX_SECONDS = 90

/**
 * マイクのボタン。押すと録音を始め、もう一度押すと止めて、声を文字にする。
 * 文字は onText に渡すだけで、送信はしない（送る前に、入力欄で確かめて直せるように）。
 */
export function MicButton({
  lang = getLang() === 'en' ? 'en' : 'ja',
  onText,
  disabled,
  size = 'md',
  label = t('マイクで話して入力する'),
}: {
  /** ja: 日本語 / en: 英語 / auto: 自動で判別 */
  lang?: 'ja' | 'en' | 'auto'
  onText: (text: string) => void
  disabled?: boolean
  size?: 'md' | 'lg'
  label?: string
}) {
  const status = useLoad(() => api.speech.status(), [], ['speech', 'settings'])
  const [phase, setPhase] = useState<'idle' | 'recording' | 'working'>('idle')
  const [level, setLevel] = useState(0)
  const [seconds, setSeconds] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const recorder = useRef<Recorder | null>(null)
  const clock = useRef<number>(undefined)
  const finishRef = useRef<() => void>(() => {})

  // 画面を閉じるときは、録音を止める
  useEffect(
    () => () => {
      window.clearInterval(clock.current)
      recorder.current?.cancel()
    },
    [],
  )
  // 準備が終わったら、案内を閉じる
  useEffect(() => {
    if (status.data?.ready) setSetupOpen(false)
  }, [status.data?.ready])

  const begin = async () => {
    setMessage(null)
    const next = new Recorder(setLevel)
    try {
      await next.start()
    } catch {
      next.cancel()
      setMessage(t('マイクを使えませんでした。マイクがつながっているか、Windows の設定（プライバシーとセキュリティ → マイク）で許可されているかを確かめてください。'))
      return
    }
    recorder.current = next
    setSeconds(0)
    setPhase('recording')
    const started = Date.now()
    clock.current = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000)
      setSeconds(elapsed)
      if (elapsed >= MAX_SECONDS) finishRef.current()
    }, 250)
  }

  const finish = async () => {
    const active = recorder.current
    if (!active) return
    recorder.current = null
    window.clearInterval(clock.current)
    setPhase('working')
    try {
      const recording = await active.stop()
      if (recording.seconds < 0.4 || recording.peak < 0.02) {
        setMessage(t('声が聞き取れませんでした。マイクに近づいて、もう一度お試しください。'))
        return
      }
      const text = await api.speech.transcribe(recording.wav, lang)
      if (text) onText(text)
      else setMessage(t('言葉を聞き取れませんでした。もう一度お試しください。'))
    } catch (e) {
      setMessage(errorMessage(e))
    } finally {
      setPhase('idle')
    }
  }
  finishRef.current = () => void finish()

  const press = () => {
    if (phase === 'recording') return void finish()
    if (phase !== 'idle') return
    if (!status.data?.ready) return setSetupOpen((open) => !open)
    void begin()
  }

  const text = phase === 'recording' ? t('録音中 {0} 秒 — もう一度押すと文字にします', seconds) : phase === 'working' ? t('文字にしています…') : message

  return (
    <span className="mic-host">
      <button
        type="button"
        className="mic"
        data-phase={phase}
        data-size={size}
        disabled={disabled || phase === 'working'}
        title={phase === 'recording' ? t('録音を止めて文字にする') : label}
        aria-label={phase === 'recording' ? t('録音を止めて文字にする') : label}
        aria-pressed={phase === 'recording'}
        style={{ '--level': level } as React.CSSProperties}
        onClick={press}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3z M5.5 11.5a6.5 6.5 0 0013 0 M12 18v3 M8.5 21h7" />
        </svg>
      </button>
      {text && (
        <span className="mic-note" role="status" data-kind={phase === 'idle' ? 'error' : 'info'}>
          {text}
          {phase === 'idle' && (
            <button type="button" aria-label={t('閉じる')} onClick={() => setMessage(null)}>
              ×
            </button>
          )}
        </span>
      )}
      {setupOpen && (
        <span className="mic-setup" role="dialog" aria-label={t('音声認識の準備')}>
          <SpeechSetup compact />
          <button type="button" className="btn btn-quiet" onClick={() => setSetupOpen(false)}>{t('閉じる')}</button>
        </span>
      )}
    </span>
  )
}
