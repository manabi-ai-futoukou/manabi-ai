import type { Course, SchoolId } from '@shared/types'
import { api, useLoad } from '../lib/hooks'
import { LOCALE, getLang, t, tx } from '@/lib/i18n'

// 作る順（科目表の並び）に合わせて、中学校を先に出す
const SCHOOLS: [SchoolId, string][] = [
  ['jhs', t('中学校')],
  ['es', t('小学校')],
  ['hs', t('高校')],
  ['hsp', t('高校（専門）')],
  ['univ', t('大学')],
  ['grad', t('大学院')],
]
const PAUSE_OPTIONS = [0.5, 0.6, 0.7, 0.8, 0.9, 1]
const CONCURRENCY_OPTIONS = Array.from({ length: 30 }, (_, i) => i + 1)

const clock = (at: number) => new Date(at).toLocaleString(LOCALE, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const percent = (value: number) => `${Math.round(value * 100)}%`

/**
 * 教材づくり。全科目の単元表と授業の本文を、AI にまとめて作らせる。
 * 使用量が上限に近づくと自動で休み、回復すると続きから再開する。アプリを開いている間だけ動く。
 */
export function Library() {
  const state = useLoad(() => api.library.get(), [], ['library'])
  const courses = useLoad(() => api.content.courses(), [], ['content', 'library'])
  const settings = useLoad(() => api.settings.get(), [], ['settings'])
  const s = state.data
  if (!s || !courses.data) return null

  const refresh = () => {
    state.reload()
    courses.reload()
  }
  const toggle = () => void api.library.setEnabled(!s.enabled).then(refresh)
  const option = (patch: Parameters<typeof api.library.setOptions>[0]) => void api.library.setOptions(patch).then(refresh)
  const done = s.totals.lessons ? s.totals.ready / s.totals.lessons : 0
  const statusText = !s.enabled
    ? t('止まっています')
    : s.status === 'paused'
      ? t('休んでいます（{0}。{1}）', s.pauseReason ?? '', s.resumeAt ? t('{0} ごろに再開します', clock(s.resumeAt)) : '')
      : s.status === 'done'
        ? s.options.talk || s.options.sims
          ? t('すべての授業と、足すもの（掛け合い・動く図解）ができあがりました')
          : t('すべての授業ができあがりました')
        : t('作成中です')

  return (
    <div className="report library">
      <header className="view-header" data-mode="textbook">
        <div className="view-header-title">
          <small>{t('教材づくり')}</small>
          <strong>{t('授業をまとめて作る')}</strong>
        </div>
        <button className={s.enabled ? 'btn' : 'btn btn-primary'} disabled={getLang() !== 'ja'} onClick={toggle}>
          {s.enabled ? t('作成を止める') : t('作成を始める')}
        </button>
      </header>

      <div className="report-scroll">
        {getLang() !== 'ja' && <p className="notice">{t('授業の作成は、日本語で表示しているときに行います。設定で言語を切りかえてください。')}</p>}
        <section className="card">
          <h2 className="section-title">{t('進み具合')}</h2>
          <p className="library-status" data-status={s.enabled ? s.status : 'idle'}>
            {statusText}
          </p>
          <div className="library-total">
            <div className="hero-figure">
              <strong>{s.totals.ready}</strong>
              <span>{tx('/ {0} 回ぶんの授業ができています（単元表は {1} / {2} 科目）', s.totals.lessons, s.totals.curricula, s.totals.courses)}</span>
            </div>
            <span className="meter-track" role="img" aria-label={t('全体の {0} が完成', percent(done))}>
              <i style={{ width: percent(done) }} />
            </span>
          </div>
          {(s.options.talk || s.totals.talks > 0) && (
            <p className="library-talks">{tx('掛け合いは {0} / {1} 回ぶんの授業に入っています。', <strong>{s.totals.talks}</strong>, s.totals.talkTargets)}</p>
          )}
          {(s.options.sims || s.totals.simChecked > 0) && (
            <p className="library-talks">{tx('動く図解は {0} 回ぶんの授業に入っています（算数・数学・理科の {1} / {2} 回ぶんを調べました）。', <strong>{s.totals.sims}</strong>, s.totals.simChecked, s.totals.simTargets)}</p>
          )}
          {s.current.length > 0 && (
            <ul className="library-current">
              {s.current.map((label) => (
                <li key={label}>
                  <span className="typing" aria-hidden>
                    <i />
                    <i />
                    <i />
                  </span>
                  {label}
                </li>
              ))}
            </ul>
          )}
          <p className="muted">{tx('AI（いまの設定: {0} {1}）が、科目の順に単元表と授業の本文を作ります。 アプリを開いている間だけ進み、閉じても次に開いたときに続きから再開します。作成している間は、PC が自動でスリープしないようにします。 まだ作られていない授業も、教科書モードで開けばその場で作れます。', settings.data?.ai.provider, settings.data?.ai.model)}</p>
        </section>

        <div className="report-grid">
          <section className="card">
            <h2 className="section-title">{t('使用量と休み方')}</h2>
            <ul className="meter-list">
              {(
                [
                  [t('5 時間あたり'), s.usage.fiveHour],
                  [t('1 週間あたり'), s.usage.sevenDay],
                ] as const
              ).map(([label, window]) => (
                <li key={label}>
                  <span className="meter-name">
                    <strong>{label}</strong>
                    <small>{window ? t('{0} に回復', clock(window.resetsAt)) : t('まだ通知がありません')}</small>
                  </span>
                  <span className="meter-track" role="img" aria-label={t('{0}の使用量 {1}', label, window ? percent(window.utilization) : t('不明'))}>
                    {window && <i style={{ width: percent(Math.min(1, window.utilization)) }} />}
                  </span>
                  <span className="meter-figure">{window ? percent(window.utilization) : '—'}</span>
                </li>
              ))}
            </ul>
            <div className="library-options">
              <label>
                <span>{t('5 時間あたりの使用量がここまで来たら休む')}</span>
                <select value={s.options.pauseAt} onChange={(e) => option({ pauseAt: Number(e.target.value) })}>
                  {PAUSE_OPTIONS.map((v) => (
                    <option key={v} value={v}>
                      {v >= 1 ? t('100%（上限まで使う）') : percent(v)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t('同時に作る数')}</span>
                <select value={s.options.concurrency} onChange={(e) => option({ concurrency: Number(e.target.value) })}>
                  {CONCURRENCY_OPTIONS.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check">
                <input type="checkbox" checked={s.options.review} onChange={(e) => option({ review: e.target.checked })} />{t('作った授業を、AI にもう一度点検させる（時間と使用量が約 2 倍になります）')}</label>
              <label className="check">
                <input type="checkbox" checked={s.options.talk} onChange={(e) => option({ talk: e.target.checked })} />{t('できあがった授業に、先生と同級生の「掛け合い」を足す（授業 1 回につき AI を 1 回呼びます。授業をすべて作り終えてから始めます）')}</label>
              <label className="check">
                <input type="checkbox" checked={s.options.sims} onChange={(e) => option({ sims: e.target.checked })} />{t('算数・数学・理科の授業に、合う「動く図解」があれば足す（授業 1 回につき AI を 1 回呼びます。合うものが無い授業には足しません）')}</label>
            </div>
            <p className="muted">{t('使用量は、Claude を使っているときに AI から届く値です。1 週間あたりの使用量が 90% に達したときも休みます。 休んでいる間に上限が回復すると、自動で再開します。')}</p>
            {s.options.concurrency > 6 && (
              <p className="muted">{tx('同時に作る数が多いほど、使用量も速く増えます。休むときや止めるときに作りかけだった授業（最大で {0} 回ぶん）は、 最後まで作ってから止まるので、決めた割合を少し超えることがあります。上限に達して作れなかったぶんは、回復したあとに作り直します。', s.options.concurrency)}</p>
            )}
            {s.options.pauseAt >= 1 && (
              <p className="muted">{t('「100%」にしている間は、5 時間あたりの上限に達するまで作りつづけます。上限に達すると、回復するまで、チャットやテストなど AI を使うほかの機能も使えなくなります。')}</p>
            )}
          </section>

          <section className="card">
            <h2 className="section-title">{t('最近の記録')}</h2>
            {s.recent.length ? (
              <ul className="library-log">
                {s.recent.map((entry, i) => (
                  <li key={i} data-ok={entry.ok}>
                    <span>{clock(entry.at)}</span>
                    <span>{entry.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t('まだ記録はありません。')}</p>
            )}
          </section>
        </div>

        {SCHOOLS.map(([school, label]) => (
          <section key={school} className="card">
            <h2 className="section-title">{label}</h2>
            {(school === 'univ' || school === 'grad') && <p className="muted">{t('大学・大学院の科目は、試作です。「先に作る」を押した科目だけを、まとめて作ります。')}</p>}
            <table className="table library-table">
              <thead>
                <tr>
                  <th>{t('科目')}</th>
                  <th>{t('単元表')}</th>
                  <th>{t('授業の本文')}</th>
                  <th className="num">{t('できた数')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {courses.data!.filter((c) => c.school === school).map((c) => (
                  <CourseRow key={c.id} course={c} first={s.priority[0] === c.id} onPrioritize={() => void api.library.prioritize(c.id).then(refresh)} />
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  )
}

function CourseRow({ course, first, onPrioritize }: { course: Course; first: boolean; onPrioritize: () => void }) {
  const ratio = course.total ? course.ready / course.total : 0
  return (
    <tr>
      <td>
        <button className="link" onClick={() => void api.settings.set({ courseId: course.id }).then(() => api.view.open('home'))}>
          {course.title}
        </button>
      </td>
      <td>{course.hasCurriculum ? t('あり') : <span className="muted">{t('まだ')}</span>}</td>
      <td>
        <span className="meter-track" role="img" aria-label={t('{0} {1} 完成', course.title, percent(ratio))}>
          <i style={{ width: percent(ratio) }} />
        </span>
      </td>
      <td className="num">
        {course.ready} / {course.total}
        {course.hasCurriculum ? '' : t('（目安）')}
      </td>
      <td className="num">
        {course.ready < course.total || !course.hasCurriculum ? (
          <button className="btn btn-quiet" disabled={first} onClick={onPrioritize}>
            {first ? t('次に作ります') : t('先に作る')}
          </button>
        ) : (
          t('完成')
        )}
      </td>
    </tr>
  )
}
