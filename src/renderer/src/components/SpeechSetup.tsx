import { useState } from 'react'
import type { SpeechModelId } from '@shared/types'
import { api, errorMessage, useLoad } from '../lib/hooks'
import { t, tx } from '@/lib/i18n'

const MODELS: { id: SpeechModelId; label: string; size: string; note: string }[] = [
  { id: 'turbo', label: t('高精度'), size: t('約 550MB'), note: t('日本語も英語も正確に聞き取ります。') },
  { id: 'small', label: t('軽量'), size: t('約 180MB'), note: t('速く動きますが、聞きまちがいが少し増えます。') },
]

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`

/**
 * 音声認識の準備（エンジンとモデルの取り寄せ）と、使うモデルの切りかえ。
 * 大きなファイルなので、使う人が押したときにだけダウンロードする。
 */
export function SpeechSetup({ compact }: { compact?: boolean }) {
  const status = useLoad(() => api.speech.status(), [], ['speech', 'settings'])
  const [picked, setPicked] = useState<SpeechModelId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const s = status.data
  if (!s) return null

  const model = picked ?? s.model
  const chosen = MODELS.find((m) => m.id === model) ?? MODELS[0]
  const installed = s.engine && s.installed.includes(model)
  const working = !!s.progress

  const install = async () => {
    setError(null)
    try {
      await api.speech.install(model)
      setPicked(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const choose = async (id: SpeechModelId) => {
    setPicked(id)
    setError(null)
    // すでに入っているモデルなら、そのまま切りかえる
    if (s.engine && s.installed.includes(id)) await api.speech.choose(id).catch((e) => setError(errorMessage(e)))
  }

  return (
    <div className={`speech-setup ${compact ? 'speech-setup-compact' : ''}`}>
      <p className="speech-state" data-ready={s.ready}>
        {s.ready ? t('マイクで話した言葉を、文字にできます。') : t('音声認識は、まだ準備されていません。')}
      </p>
      <div className="segmented" aria-label={t('音声モデル')}>
        {MODELS.map((m) => (
          <button key={m.id} aria-pressed={model === m.id} disabled={working} onClick={() => void choose(m.id)}>
            {m.label}（{m.size}）{s.installed.includes(m.id) ? ' ✓' : ''}
          </button>
        ))}
      </div>
      <small>{chosen.note}</small>

      {s.progress ? (
        <div className="speech-progress" role="status">
          <span>
            {s.progress.label}
            {s.progress.total > 0 && `… ${megabytes(s.progress.received)} / ${megabytes(s.progress.total)}`}
          </span>
          <span className="meter-track">
            <i style={{ width: `${s.progress.total ? Math.round((s.progress.received / s.progress.total) * 100) : 100}%` }} />
          </span>
        </div>
      ) : (
        !installed && (
          <button className="btn btn-primary" onClick={() => void install()}>{tx('音声認識を準備する（{0}のダウンロード）', s.engine ? chosen.size : `${chosen.size} + 9MB`)}</button>
        )
      )}
      {(error ?? s.error) && <p className="form-error">{error ?? s.error}</p>}
      {!compact && (
        <p className="muted">{t('声は、この PC の中だけで文字にします（外へは送りません）。準備では、音声認識のエンジン whisper.cpp を GitHub から、音声モデルを Hugging Face から取り寄せます。 文字になった言葉は入力欄に入るだけなので、送る前に確かめて直せます。')}</p>
      )}
    </div>
  )
}
