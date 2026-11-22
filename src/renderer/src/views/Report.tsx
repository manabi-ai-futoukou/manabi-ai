import { useState } from 'react'
import type { AxisKey, SkillKey, WeeklyReport } from '@shared/types'
import { Markdown } from '../components/Markdown'
import { Portrait } from '../components/Portrait'
import { api, errorMessage, useLoad } from '../lib/hooks'
import { LOCALE, t, tx } from '@/lib/i18n'

const AXES: { key: AxisKey; label: string; hint: string }[] = [
  { key: 'understanding', label: t('理解力'), hint: t('授業の内容を正しく理解できているか') },
  { key: 'application', label: t('応用力'), hint: t('自分の言葉で組み立て直せているか') },
  { key: 'creativity', label: t('発想力'), hint: t('テーマを自分なりに広げられているか') },
  { key: 'memory', label: t('記憶力'), hint: t('テストでどれだけ答えられたか') },
  { key: 'persistence', label: t('継続力'), hint: t('どれだけ続けて学習できたか') },
]
const WEEKDAYS = [t('月'), t('火'), t('水'), t('木'), t('金'), t('土'), t('日')]
const SKILLS: { key: SkillKey; label: string; hint: string; count: string; unit: string }[] = [
  { key: 'debate', label: t('ディベート力'), hint: t('論理で相手とジャッジを説得する力'), count: t('ディベートで'), unit: t('勝') },
  { key: 'english', label: t('英会話力'), hint: t('英語でやりとりする力'), count: t('英会話で'), unit: t('回やりとり') },
  { key: 'kanji', label: t('漢字力'), hint: t('正しい形と書き順で書く力'), count: t('漢字特訓で'), unit: t('字クリア') },
  { key: 'vocabJa', label: t('語彙力（日本語）'), hint: t('言葉を知り、使いこなす力'), count: t('語彙力特訓で'), unit: t('語クリア') },
  { key: 'vocabEn', label: t('語彙力（英語）'), hint: t('英単語を知り、使いこなす力'), count: t('語彙力特訓で'), unit: t('語クリア') },
]

const shortDate = (key: string) => {
  const [, m, d] = key.split('-').map(Number)
  return `${m}/${d}`
}
const weekLabel = (report: WeeklyReport) =>
  t('{0}〜{1} の週{2}', shortDate(report.weekStart), shortDate(report.weekEnd), report.final ? '' : t('（今週・途中）'))
const formatDate = (at: number) =>
  new Date(at).toLocaleString(LOCALE, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** 成績。週ごとに、教科の評価を 5 つの観点で見る。好感度とテストの記録もここで確かめられる。 */
export function Report() {
  const courses = useLoad(() => api.content.courses(), [], [])
  const settings = useLoad(() => api.settings.get(), [], [])
  const recorded = useLoad(() => api.report.subjects(), [], ['report'])
  const [pickedSubject, setPickedSubject] = useState<string | null>(null)
  // 評価は教科（学校 + 教科）ごと。はじめは、ホームで開いている科目の教科を表示する
  const subjectId = pickedSubject ?? courses.data?.find((c) => c.id === settings.data?.courseId)?.subjectId ?? ''
  const subjects = [...new Set([subjectId, ...(recorded.data ?? [])])].filter(Boolean)
  const subjectName = (id: string) => {
    const course = courses.data?.find((c) => c.subjectId === id)
    return course ? `${course.schoolLabel} ${course.subjectLabel}` : id
  }
  const reports = useLoad(() => (subjectId ? api.report.list(subjectId) : Promise.resolve([])), [subjectId], ['report'])
  const tests = useLoad(() => api.test.results(), [], ['test'])
  const skills = useLoad(() => api.skills.get(), [], ['skills'])
  const characters = useLoad(() => api.characters.list(), [], ['characters'])
  const [week, setWeek] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const list = reports.data ?? []
  const report = list.find((r) => r.weekStart === week) ?? list[0]
  const teacher = characters.data?.find((c) => c.role === 'teacher')
  if (!report) return null

  const askComment = async () => {
    setAsking(true)
    setError(null)
    try {
      await api.report.comment(report.weekStart, subjectId)
      reports.reload()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="report">
      <header className="view-header" data-mode="review">
        <div className="view-header-title">
          <small>{t('成績')}</small>
          <strong>{report.subjectTitle}</strong>
        </div>
        <label className="report-week">
          <span>{t('教科')}</span>
          <select value={subjectId} onChange={(e) => (setPickedSubject(e.target.value), setWeek(null))}>
            {subjects.map((id) => (
              <option key={id} value={id}>
                {subjectName(id)}
              </option>
            ))}
          </select>
        </label>
        <label className="report-week">
          <span>{t('週')}</span>
          <select value={report.weekStart} onChange={(e) => setWeek(e.target.value)}>
            {list.map((r) => (
              <option key={r.weekStart} value={r.weekStart}>
                {weekLabel(r)}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="report-scroll">
        <div className="report-grid">
          <section className="card">
            <h2 className="section-title">{report.final ? t('この週の評価') : t('今週の評価（途中経過）')}</h2>
            <div className="report-overall">
              {report.overall === null ? (
                <p className="report-empty">{t('この週の学習の記録は、まだありません。')}</p>
              ) : (
                <div className="hero-figure">
                  <strong>{report.overall}</strong>
                  <span>{t('点（総合）')}</span>
                </div>
              )}
              <p className="muted">
                {report.final ? t('確定済みです。') : t('日曜日が終わると、この週の評価が確定します。')}
              </p>
            </div>

            <ul className="meter-list">
              {AXES.map((axis) => {
                const value = report.axes[axis.key]
                return (
                  <li key={axis.key}>
                    <span className="meter-name">
                      <strong>{axis.label}</strong>
                      <small>{axis.hint}</small>
                    </span>
                    <span className="meter-track" role="img" aria-label={`${axis.label} ${value.score === null ? t('記録なし') : t('{0} 点', value.score)}`}>
                      {value.score !== null && <i style={{ width: `${value.score}%` }} />}
                    </span>
                    <span className="meter-figure">
                      {value.score ?? '—'}
                      {value.score !== null && <small>{t('点')}</small>}
                    </span>
                    <small className="meter-basis">{value.basis}</small>
                  </li>
                )
              })}
            </ul>
          </section>

          <section className="card">
            <h2 className="section-title">{t('学習した時間')}</h2>
            <p className="report-time">
              {tx('{0} 分{1}', <strong>{report.activeMinutes}</strong>, <span>{tx('／ 10 分以上学習した日 {0} 日', report.activeDays)}</span>)}
            </p>
            <DailyBars report={report} />
            <p className="muted">{t('教科書・ディベート・ノート・テストのウィンドウを手前に開いて、操作している時間だけを数えます。開いたまま置いている時間は数えません。')}</p>
          </section>
        </div>

        <section className="card report-comment">
          <h2 className="section-title">{t('先生の講評')}</h2>
          {report.comment ? (
            <div className="evaluation-head">
              {teacher && <Portrait character={teacher} size="md" />}
              <div className="bubble bubble-right">
                <Markdown>{report.comment}</Markdown>
              </div>
            </div>
          ) : (
            <p className="muted">{tx('この週の評価について、{0}に講評を書いてもらえます。', teacher?.name ?? t('先生'))}</p>
          )}
          {error && <p className="form-error">{error}</p>}
          <button className="btn" disabled={asking || report.overall === null} onClick={() => void askComment()}>
            {asking ? t('講評を書いています…') : report.comment ? t('もう一度書いてもらう') : t('講評を書いてもらう')}
          </button>
        </section>

        <div className="report-grid">
          <section className="card">
            <h2 className="section-title">{t('テストの記録')}</h2>
            {tests.data?.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('日時')}</th>
                    <th>{t('単元')}</th>
                    <th className="num">{t('問題')}</th>
                    <th className="num">{t('点数')}</th>
                  </tr>
                </thead>
                <tbody>
                  {tests.data.slice(0, 12).map((t) => (
                    <tr key={t.id}>
                      <td>{formatDate(t.finishedAt)}</td>
                      <td>
                        <button className="link" onClick={() => void api.view.open('test', { testResultId: t.id })}>
                          {t.unitTitle}
                        </button>
                      </td>
                      <td className="num">{tx('{0} 問', t.results.length)}</td>
                      <td className="num">{tx('{0} 点', t.score)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">{t('まだテストを受けていません。')}</p>
            )}
            <button className="btn btn-mode" data-mode="test" onClick={() => void api.view.open('test')}>{t('テストを受ける')}</button>
          </section>

          <section className="card">
            <h2 className="section-title">{t('特訓とディベートで育つ力')}</h2>
            <ul className="meter-list">
              {SKILLS.map((skill) => {
                const value = Math.round(skills.data?.values[skill.key] ?? 0)
                return (
                  <li key={skill.key}>
                    <span className="meter-name">
                      <strong>{skill.label}</strong>
                      <small>{skill.hint}</small>
                    </span>
                    <span className="meter-track" role="img" aria-label={t('{0} {1} 点', skill.label, value)}>
                      <i style={{ width: `${value}%` }} />
                    </span>
                    <span className="meter-figure">
                      {value}
                      <small>{t('点')}</small>
                    </span>
                    <small className="meter-basis">
                      {skill.count} {skills.data?.counts[skill.key] ?? 0} {skill.unit}
                    </small>
                  </li>
                )
              })}
            </ul>
            <p className="muted">{t('教科とは別に、積み重ねで少しずつ上がります。はじめは伸びやすく、100 点に近づくほどゆっくりになります。')}</p>
          </section>
        </div>

        <details className="card rules">
          <summary>{t('評価の決まり')}</summary>
          <ul>
            <li>{t('1 週間は月曜日から日曜日までです。週が終わると、その週の評価が確定します。')}</li>
            <li>{t('理解力・応用力・発想力は、その週に先生が評価したノートの平均です。同じノートを何度か見てもらった場合は、最後の評価を使います。')}</li>
            <li>{t('記憶力は、その週に受けたテストの平均点です。')}</li>
            <li>{t('継続力は、10 分以上学習した日が 5 日で 50 点、1 週間の合計が 300 分で 50 点の、合わせて 100 点満点です。')}</li>
            <li>{t('総合は、記録がある観点の平均です。')}</li>
            <li>{t('ディベート力は勝つたびに、英会話力はやりとりのたびに、漢字力と語彙力は 1 つクリアするたびに上がります。')}</li>
          </ul>
        </details>
      </div>
    </div>
  )
}

/** 曜日ごとの学習時間（分）の棒グラフ */
function DailyBars({ report }: { report: WeeklyReport }) {
  const [hover, setHover] = useState<number | null>(null)
  const values = report.dailyMinutes
  const peak = Math.max(...values)
  // 目盛りの上限は、30 分きざみで切りのよい値にする（最低 60 分）
  const top = Math.max(60, Math.ceil(peak / 30) * 30)
  const ticks = [0, top / 2, top]

  const width = 520
  const height = 210
  const left = 40
  const right = 12
  const plotTop = 22
  const plotBottom = 172
  const band = (width - left - right) / 7
  const bar = Math.min(24, band * 0.5)
  const y = (v: number) => plotBottom - (v / top) * (plotBottom - plotTop)
  const [startYear, startMonth, startDay] = report.weekStart.split('-').map(Number)
  const start = new Date(startYear, startMonth - 1, startDay)
  const dateOf = (i: number) => {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    return `${d.getMonth() + 1}/${d.getDate()}`
  }

  return (
    <figure className="chart">
      <div className="chart-plot">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('曜日ごとの学習時間の棒グラフ')}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} className={t === 0 ? 'chart-baseline' : 'chart-grid'} />
              <text x={left - 8} y={y(t) + 4} textAnchor="end" className="chart-tick">
                {t}
              </text>
            </g>
          ))}
          <text x={left - 8} y={plotTop - 10} textAnchor="end" className="chart-tick">{t('分')}</text>
          {values.map((v, i) => {
            const cx = left + band * (i + 0.5)
            const h = plotBottom - y(v)
            const r = Math.min(4, h)
            return (
              <g key={i}>
                {v > 0 && (
                  // 上の角だけを丸め、下は基準線にぴったり付ける
                  <path
                    className="chart-bar"
                    data-active={hover === i}
                    d={`M${cx - bar / 2},${plotBottom} V${y(v) + r} Q${cx - bar / 2},${y(v)} ${cx - bar / 2 + r},${y(v)} H${cx + bar / 2 - r} Q${cx + bar / 2},${y(v)} ${cx + bar / 2},${y(v) + r} V${plotBottom} Z`}
                  />
                )}
                {/* いちばん長い日だけ、値を棒の上に書く。ほかの日は、重ねたときの表示と下の表で読める */}
                {v > 0 && v === peak && hover === null && (
                  <text x={cx} y={y(v) - 6} textAnchor="middle" className="chart-value">
                    {tx('{0} 分', v)}</text>
                )}
                <text x={cx} y={plotBottom + 18} textAnchor="middle" className="chart-label">
                  {WEEKDAYS[i]}
                </text>
                <text x={cx} y={plotBottom + 33} textAnchor="middle" className="chart-tick">
                  {dateOf(i)}
                </text>
                {/* 棒より広い範囲で反応させる */}
                <rect
                  x={left + band * i}
                  y={plotTop - 14}
                  width={band}
                  height={plotBottom - plotTop + 50}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={t('{0}（{1}）{2} 分', dateOf(i), WEEKDAYS[i], v)}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                />
              </g>
            )
          })}
        </svg>
        {hover !== null && (
          <div
            className="chart-tooltip"
            style={{ left: `${((left + band * (hover + 0.5)) / width) * 100}%`, top: `${(Math.max(plotTop, y(values[hover]) - 8) / height) * 100}%` }}
          >
            <strong>{tx('{0} 分', values[hover])}</strong>
            <span>
              {dateOf(hover)}（{WEEKDAYS[hover]}）
            </span>
          </div>
        )}
      </div>
      <details className="chart-table">
        <summary>{t('表で見る')}</summary>
        <table className="table">
          <thead>
            <tr>
              {WEEKDAYS.map((d, i) => (
                <th key={d} className="num">
                  {dateOf(i)}（{d}）
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {values.map((v, i) => (
                <td key={i} className="num">
                  {tx('{0} 分', v)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </details>
    </figure>
  )
}
