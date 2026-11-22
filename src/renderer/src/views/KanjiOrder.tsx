import { useEffect, useMemo, useState } from 'react'
import { KANJI_BOX } from '@shared/kanji'
import { api, useLoad } from '../lib/hooks'
import { pathLength, samplePath } from '../lib/kanjiStroke'
import { t, tx } from '@/lib/i18n'

const SPEEDS = [
  { value: 0.5, label: t('ゆっくり') },
  { value: 1, label: t('ふつう') },
  { value: 2, label: t('はやい') },
]

/**
 * 漢字特訓モード（2 つ目のウィンドウ）。書き順のアニメーション。
 * 1 画ずつ、線が引かれていく様子を見せる。くり返し再生したり、1 画ずつ進めたりできる。
 */
export function KanjiOrder() {
  const state = useLoad(() => api.kanji.state(), [], ['kanji'])
  const entry = state.data?.entry ?? null
  const [speed, setSpeed] = useState(1)
  /** 再生し直すたびに増やす（アニメーションを最初から始めるため） */
  const [run, setRun] = useState(0)
  /** 1 画ずつ見るとき、何画目まで出すか。null なら通して再生 */
  const [step, setStep] = useState<number | null>(null)

  const strokes = useMemo(
    () => (entry?.strokes ?? []).map((d) => ({ d, length: pathLength(d), start: samplePath(d, 2)[0] })),
    [entry?.char],
  )

  // 字が変わったら、最初から再生する
  useEffect(() => {
    setStep(null)
    setRun((n) => n + 1)
  }, [entry?.char])

  if (!state.data) return null
  if (!entry) {
    return (
      <div className="kanji-order">
        <p className="view-error">{t('漢字特訓を始めると、ここに書き順が出ます。')}</p>
      </div>
    )
  }

  // 1 画にかける時間（秒）。長い線ほど、少し長くする
  const duration = (length: number) => Math.max(0.35, length / 110) / speed
  const pause = 0.25 / speed
  let clock = 0.3
  const timed = strokes.map((stroke, i) => {
    const visible = step === null || i < step
    const animated = step === null || i === step - 1
    const delay = step === null ? clock : 0
    if (step === null) clock += duration(stroke.length) + pause
    return { ...stroke, visible, animated, delay }
  })

  const next = () => setStep((current) => (current === null || current >= strokes.length ? 1 : current + 1))

  return (
    <div className="kanji-order">
      <header className="view-header" data-mode="kanji">
        <div className="view-header-title">
          <small>{t('漢字特訓 ／ 書き順')}</small>
          <strong>{tx('「{0}」 {1} 画{2}', entry.char, strokes.length, step !== null && t('（{0} 画目）', step))}
          </strong>
        </div>
      </header>

      <div className="kanji-order-stage">
        <svg viewBox={`0 0 ${KANJI_BOX} ${KANJI_BOX}`} role="img" aria-label={t('{0} の書き順', entry.char)}>
          <rect x="1" y="1" width={KANJI_BOX - 2} height={KANJI_BOX - 2} className="kanji-frame" />
          <path d={`M${KANJI_BOX / 2},1V${KANJI_BOX - 1}M1,${KANJI_BOX / 2}H${KANJI_BOX - 1}`} className="kanji-guide" />
          {strokes.map((stroke, i) => (
            <path key={`bg${i}`} d={stroke.d} className="kanji-ghost" />
          ))}
          {timed.map(
            (stroke, i) =>
              stroke.visible && (
                <path
                  key={`${run}-${step}-${i}`}
                  d={stroke.d}
                  className="kanji-ink"
                  style={
                    stroke.animated
                      ? {
                          strokeDasharray: stroke.length + 1,
                          strokeDashoffset: stroke.length + 1,
                          animation: `kanji-draw ${duration(stroke.length)}s linear ${stroke.delay}s forwards`,
                        }
                      : undefined
                  }
                />
              ),
          )}
          {strokes.map((stroke, i) => (
            <text key={`n${i}`} x={stroke.start[0] - 3.2} y={stroke.start[1] - 1.6} className="kanji-number" data-on={step === null || i < step}>
              {i + 1}
            </text>
          ))}
        </svg>
      </div>

      <footer className="kanji-order-bar">
        <button
          className="btn btn-primary"
          onClick={() => {
            setStep(null)
            setRun((n) => n + 1)
          }}
        >{t('もう一度')}</button>
        <button className="btn" onClick={next}>{tx('1 画ずつ{0}', step !== null && step < strokes.length ? t('（次へ）') : '')}
        </button>
        <span className="pager-spacer" />
        <div className="segmented" aria-label={t('速さ')}>
          {SPEEDS.map((s) => (
            <button
              key={s.value}
              aria-pressed={speed === s.value}
              onClick={() => {
                setSpeed(s.value)
                setRun((n) => n + 1)
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </footer>
    </div>
  )
}
