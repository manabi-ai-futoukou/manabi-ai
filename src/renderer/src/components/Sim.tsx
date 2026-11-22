import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { SIMS, parseSim, simParams } from '@shared/sims'
import { SIM_VIEWS } from './SimViews'
import { t } from '@/lib/i18n'

const minus = (value: number) => String(value).replace('-', '−')

/**
 * 動く図解（```sim）。スライダーや選択で条件を変えると、図と数値が計算しなおされる。
 * render は、課題の文（数式や太字をふくむ）を描く関数。
 */
export function Sim({ source, render }: { source: string; render: (text: string) => ReactNode }) {
  const spec = useMemo(() => parseSim(source), [source])
  const [values, setValues] = useState<Record<string, number>>(spec?.values ?? {})
  const [choices, setChoices] = useState<Record<string, string>>(spec?.choices ?? {})
  // 別の授業に切りかえたときは、その授業のはじめの値にする
  useEffect(() => {
    setValues(spec?.values ?? {})
    setChoices(spec?.choices ?? {})
  }, [spec])

  if (!spec) return <p className="figure-error">{t('（動く図解を表示できませんでした）')}</p>
  const def = SIMS[spec.kind]
  const View = SIM_VIEWS[spec.kind]
  const params = simParams(spec)
  const changed = Object.keys(spec.values).some((name) => values[name] !== spec.values[name]) || Object.keys(spec.choices).some((name) => choices[name] !== spec.choices[name])

  return (
    <figure className="sim" data-kind={spec.kind}>
      <figcaption className="sim-head">
        <span className="sim-badge">{t('動く図解')}</span>
        <strong>{def.title}</strong>
      </figcaption>
      {spec.task && <div className="sim-task">{render(spec.task)}</div>}
      <div className="sim-stage">
        <View spec={spec} values={{ ...spec.values, ...values }} choices={{ ...spec.choices, ...choices }} render={render} />
      </div>
      <div className="sim-controls">
        {Object.entries(def.choices ?? {}).map(([name, choice]) => (
          <label key={name} className="sim-choice">
            <span>{choice.label}</span>
            <select value={choices[name] ?? spec.choices[name]} onChange={(e) => setChoices({ ...choices, [name]: e.target.value })}>
              {Object.entries(choice.options).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ))}
        {Object.entries(params)
          .filter(([, param]) => !param.when || param.when.values.includes(choices[param.when.choice] ?? spec.choices[param.when.choice]))
          .map(([name, param]) => (
          <label key={name} className="sim-slider">
            <span>{param.label}</span>
            <input
              type="range"
              min={param.min}
              max={param.max}
              step={param.step}
              value={values[name] ?? spec.values[name]}
              onChange={(e) => setValues({ ...values, [name]: Number(e.target.value) })}
            />
            <output>
              {minus(values[name] ?? spec.values[name])}
              {param.unit && <small> {param.unit}</small>}
            </output>
          </label>
        ))}
        {changed && (
          <button
            className="btn btn-quiet sim-reset"
            onClick={() => {
              setValues(spec.values)
              setChoices(spec.choices)
            }}
          >{t('はじめの値にもどす')}</button>
        )}
      </div>
    </figure>
  )
}
