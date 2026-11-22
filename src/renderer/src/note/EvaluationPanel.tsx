import { useEffect, useState } from 'react'
import type { CharacterDef, NoteEvaluation } from '@shared/types'
import { Markdown } from '../components/Markdown'
import { Portrait } from '../components/Portrait'
import { LOCALE, t, tx } from '@/lib/i18n'

const AXES = [
  { key: 'understanding', label: t('理解力'), hint: t('授業の内容を正しく理解できているか') },
  { key: 'application', label: t('応用力'), hint: t('自分の言葉で組み立て直せているか') },
  { key: 'creativity', label: t('発想力'), hint: t('テーマを自分なりに広げられているか') },
] as const

function expressionFor(evaluation: NoteEvaluation): string {
  const average = (evaluation.understanding.score + evaluation.application.score + evaluation.creativity.score) / 3
  if (average >= 80) return 'praise'
  if (average >= 60) return 'smile'
  if (average >= 40) return 'thinking'
  // 点が低いときも、困った顔は見せない（先生は、責めずに見守る）
  return 'gentle'
}

const formatDate = (at: number) =>
  new Date(at).toLocaleString(LOCALE, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** 先生によるノートの評価（理解力・応用力・発想力） */
export function EvaluationPanel({
  teacher,
  evaluations,
  evaluating,
  error,
  onEvaluate,
}: {
  teacher: CharacterDef | undefined
  evaluations: NoteEvaluation[]
  evaluating: boolean
  error: string | null
  onEvaluate: () => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  // 新しい評価が届いたら、それを表示する
  useEffect(() => setSelected(null), [evaluations[0]?.id])
  const current = evaluations.find((e) => e.id === selected) ?? evaluations[0]

  return (
    <div className="evaluation">
      {evaluating ? (
        <div className="evaluation-waiting">
          {teacher && <Portrait character={teacher} expression="thinking" size="lg" />}
          <p>
            <strong>{tx('{0}がノートを読んでいます…', teacher?.name ?? t('先生'))}</strong>
          </p>
          <p className="muted">{t('30 秒〜1 分ほどかかります。このまま続きを書いていても大丈夫です。')}</p>
        </div>
      ) : (
        <button className="btn btn-primary btn-wide" onClick={onEvaluate}>
          {evaluations.length ? t('もう一度見てもらう') : t('{0}に見てもらう', teacher?.name ?? t('先生'))}
        </button>
      )}
      {error && <p className="form-error">{error}</p>}

      {!current && !evaluating && (
        <p className="muted">{t('ノートを書いたら、先生に見てもらいましょう。「理解力」「応用力」「発想力」の 3 つの観点で、100 点満点の評価と感想がもらえます。')}</p>
      )}

      {current && (
        <>
          <div className="evaluation-head">
            {teacher && <Portrait character={teacher} expression={expressionFor(current)} size="md" />}
            <div className="bubble bubble-right">
              <Markdown>{current.overall}</Markdown>
            </div>
          </div>

          <ul className="scores">
            {AXES.map((axis) => {
              const value = current[axis.key]
              return (
                <li key={axis.key} data-axis={axis.key}>
                  <div className="score-top">
                    <strong>{axis.label}</strong>
                    <small>{axis.hint}</small>
                    <span className="score-number">
                      {value.score}
                      <small>{t('点')}</small>
                    </span>
                  </div>
                  <div className="meter meter-wide" role="img" aria-label={t('{0} {1} 点', axis.label, value.score)}>
                    <i style={{ width: `${value.score}%` }} />
                  </div>
                  <Markdown>{value.comment}</Markdown>
                </li>
              )
            })}
          </ul>

          <div className="advice">
            <strong>{t('次の一歩')}</strong>
            <Markdown>{current.advice}</Markdown>
          </div>

          <p className="muted evaluation-meta">
            {tx('{0} ／ p.{1} を評価', formatDate(current.at), current.pages.join(t('・')))}{current.copyRate !== null && <>{tx('／ 教科書や会話と同じ文の割合（参考）: {0}%', Math.round(current.copyRate * 100))}</>}
          </p>

          {evaluations.length > 1 && (
            <label className="evaluation-history">
              <span>{t('これまでの評価')}</span>
              <select value={current.id} onChange={(e) => setSelected(e.target.value)}>
                {evaluations.map((e) => (
                  <option key={e.id} value={e.id}>
                    {tx('{0}　理解 {1}・応用 {2}・発想 {3}', formatDate(e.at), e.understanding.score, e.application.score, e.creativity.score)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
    </div>
  )
}
