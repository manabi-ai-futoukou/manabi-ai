import { useState } from 'react'
import type { CharacterDef, LessonMeta } from '@shared/types'
import { AiSettings } from '../components/AiSettings'
import { CharacterEditor } from '../components/CharacterEditor'
import { CoursePicker, FieldNote } from '../components/CoursePicker'
import { Portrait } from '../components/Portrait'
import { SpeechSetup } from '../components/SpeechSetup'
import { api, errorMessage, useLoad } from '../lib/hooks'
import { getLang, t, tx } from '@/lib/i18n'

/** 時間帯に合わせた先生のあいさつ（AI は呼ばず、あらかじめ用意した言葉を使う） */
function greeting(hour: number): { text: string; expression: string } {
  if (hour >= 5 && hour < 10) return { text: t('おはようございます。今日はどの授業から始めましょうか。'), expression: 'smile' }
  if (hour >= 10 && hour < 17) return { text: t('こんにちは。あなたのペースで、ゆっくり進めていきましょうね。'), expression: 'joy' }
  if (hour >= 17 && hour < 22) return { text: t('こんばんは。今日も少しだけ進めてみましょうか。'), expression: 'wink' }
  return { text: t('夜おそくまでおつかれさまです。切りのいいところで、ゆっくり休んでくださいね。'), expression: 'gentle' }
}

const STATUS_LABEL: Record<LessonMeta['status'], string> = {
  authored: t('用意済み'),
  generated: t('AI が作成'),
  none: t('まだありません'),
}

const STEPS = [
  { mode: 'textbook', title: t('教科書を読む'), text: t('授業を自分のペースで読みます。') },
  { mode: 'chat', title: t('質問する'), text: t('わからないところを先生や同級生に聞きます。') },
  { mode: 'note', title: t('ノートにまとめる'), text: t('学んだことを自分の言葉で書きます。') },
  { mode: 'review', title: t('見てもらう'), text: t('先生がノートを読んで評価します。') },
]

export function Home() {
  const settings = useLoad(() => api.settings.get(), [], ['settings'])
  const courses = useLoad(() => api.content.courses(), [], ['content'])
  const [picked, setPicked] = useState<string | null>(null)
  const wantedId = picked ?? settings.data?.courseId ?? ''
  // 覚えている科目が、科目表に無いことがある（一部の科目だけを載せたサイトなど）。そのときは、はじめの科目を開く
  const courseId = courses.data?.length && !courses.data.some((c) => c.id === wantedId) ? courses.data[0].id : wantedId
  const course = courses.data?.find((c) => c.id === courseId)
  const curriculum = useLoad(() => (courseId ? api.content.curriculum(courseId) : Promise.resolve(null)), [courseId], ['content'])
  const characters = useLoad(() => api.characters.list(), [], ['characters'])
  const notebooks = useLoad(() => api.notes.list(), [], ['notes', 'evaluations'])
  const reports = useLoad(() => (course ? api.report.list(course.subjectId) : Promise.resolve([])), [course?.subjectId], ['report'])
  const library = useLoad(() => api.library.get(), [], ['library'])
  const [openUnit, setOpenUnit] = useState<string | null>(null)
  const [editing, setEditing] = useState<CharacterDef | null>(null)
  const [making, setMaking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const teacher = characters.data?.find((c) => c.role === 'teacher')
  const hello = greeting(new Date().getHours())
  const units = curriculum.data?.units ?? []
  const activeUnit = openUnit ?? units[0]?.id
  const hasNote = (lessonId: string) => notebooks.data?.some((n) => n.kind === 'lesson' && n.lessonId === lessonId)
  const thisWeek = reports.data?.[0]
  const totals = library.data?.totals

  const choose = (id: string) => {
    setPicked(id)
    setOpenUnit(null)
    setError(null)
    void api.settings.set({ courseId: id })
  }
  const makeCurriculum = async () => {
    setMaking(true)
    setError(null)
    try {
      await api.content.ensureCurriculum(courseId)
      curriculum.reload()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setMaking(false)
    }
  }

  return (
    <div className="home">
      <header className="home-hero">
        <div className="home-brand">
          <p className="home-tagline">{t('流動する教科書')}</p>
          <h1>{t('学びアイ')}</h1>
        </div>
        {teacher && (
          <div className="home-hello">
            <div className="bubble bubble-left">
              <strong>{teacher.name}</strong>
              <p>{hello.text}</p>
            </div>
            <Portrait character={teacher} expression={hello.expression} size="lg" />
          </div>
        )}
      </header>

      <ol className="steps" aria-label={t('授業の流れ')}>
        {STEPS.map((step, i) => (
          <li key={step.mode} data-mode={step.mode}>
            <span className="steps-number">{i + 1}</span>
            <div>
              <strong>{step.title}</strong>
              <p>{step.text}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="home-columns">
        <main className="home-main">
          <div className="home-course">
            <h2 className="section-title">{course?.title ?? ''}</h2>
            {courses.data && <CoursePicker courses={courses.data} value={courseId} onChange={choose} />}
          </div>
          {course && <p className="muted home-scope">{course.scope}</p>}
          {course && <FieldNote course={course} />}

          {course && curriculum.data === null && (
            <div className="card home-empty">
              <p>{t('この科目の単元表は、まだ作られていません。')}</p>
              <p className="muted">{t('AI が学習指導要領にもとづいて、単元と授業の一覧を作ります（30 秒ほど）。授業の本文は、開いたときに 1 つずつ作ることも、「教材づくり」でまとめて作ることもできます。')}</p>
              {error && <p className="form-error">{error}</p>}
              {getLang() === 'ja' ? (
                <button className="btn btn-primary" disabled={making} onClick={() => void makeCurriculum()}>
                  {making ? t('単元表を作っています…') : t('この科目の単元表を作る')}
                </button>
              ) : (
                <p className="muted">{t('授業の作成は、日本語で表示しているときに行います。設定で言語を切りかえてください。')}</p>
              )}
            </div>
          )}

          {units.map((unit) => {
            const open = unit.id === activeUnit
            const ready = unit.lessons.filter((l) => l.status !== 'none').length
            return (
              <section key={unit.id} className={`unit ${open ? 'unit-open' : ''}`}>
                <button className="unit-header" aria-expanded={open} onClick={() => setOpenUnit(open ? '' : unit.id)}>
                  <span className="unit-number">{unit.number}</span>
                  <span className="unit-heading">
                    <strong>{unit.title}</strong>
                    <small>{unit.domain}</small>
                  </span>
                  <span className="unit-count">
                    {tx('{0} / {1} 回', ready, unit.lessons.length)}</span>
                  <span className="unit-chevron" aria-hidden>
                    {open ? '▾' : '▸'}
                  </span>
                </button>
                {open && (
                  <div className="unit-body">
                    <p className="unit-summary">{unit.summary}</p>
                    <ul className="lessons">
                      {unit.lessons.map((lesson) => {
                        const readable = lesson.status !== 'none' || lesson.deep
                        return (
                          <li key={lesson.id} className="lesson-row">
                            <span className="lesson-number">{lesson.number}</span>
                            <div className="lesson-info">
                              <strong>{lesson.title}</strong>
                              <small>{lesson.summary}</small>
                            </div>
                            <span className="chip" data-status={lesson.status}>
                              {STATUS_LABEL[lesson.status]}
                            </span>
                            <div className="lesson-actions">
                              <button className="btn btn-mode" data-mode="textbook" onClick={() => void api.view.open('textbook', { lessonId: lesson.id })}>{t('教科書')}</button>
                              <button
                                className="btn btn-mode"
                                data-mode="chat"
                                disabled={!readable}
                                title={readable ? undefined : t('先に教科書を用意してください')}
                                onClick={() => void api.view.open('chat', { lessonId: lesson.id })}
                              >{t('質問')}</button>
                              <button className="btn btn-mode" data-mode="note" onClick={() => void api.view.open('note', { lessonId: lesson.id })}>{tx('ノート{0}', hasNote(lesson.id) ? ' ●' : '')}
                              </button>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </section>
            )
          })}
        </main>

        <aside className="home-side">
          <section className="card home-progress">
            <h2 className="section-title">{t('力だめしと成績')}</h2>
            <p className="home-week">{tx('今週の総合{0}{1}{2}', <strong>{thisWeek?.overall ?? '—'}</strong>, thisWeek?.overall != null && <span>{t('点')}</span>, <small>
                {tx('{0} 学習 {1} 分', thisWeek?.subjectTitle, thisWeek?.activeMinutes ?? 0)}</small>)}
            </p>
            <div className="home-progress-actions">
              <button className="btn btn-mode" data-mode="test" onClick={() => void api.view.open('test')}>{t('テストを受ける')}</button>
              <button className="btn btn-mode" data-mode="test" title={t('100 字ほどの記述と、序論・本論・結論で書く論述を練習します')} onClick={() => void api.view.open('essay')}>{t('記述・論述の練習')}</button>
              <button className="btn btn-mode" data-mode="review" onClick={() => void api.view.open('report')}>{t('成績を見る')}</button>
            </div>
          </section>

          {/* 教材づくりは、開発用の版だけ（配る版では出さない） */}
          {api.authoring && <section className="card home-library">
            <h2 className="section-title">{t('教材づくり')}</h2>
            <p className="muted">{tx('全 {0} 科目のうち、授業の本文は {1} / {2} 回ぶんができています。{3}{4}', totals?.courses ?? '—', totals?.ready ?? '—', totals?.lessons ?? '—', library.data?.status === 'running' && t(' いま、AI がまとめて作っています。'), library.data?.status === 'paused' && t(' 使用量の回復を待って、休んでいます。'))}
            </p>
            <button className="btn btn-mode" data-mode="textbook" onClick={() => void api.view.open('library')}>{t('教材づくりを開く')}</button>
          </section>}

          <section className="card home-modes">
            <h2 className="section-title">{t('特訓とディベート')}</h2>
            <div className="home-progress-actions">
              <button className="btn btn-mode" data-mode="debate" onClick={() => void api.view.open('debate')}>{t('ディベート')}</button>
              <button className="btn btn-mode" data-mode="eikaiwa" onClick={() => void api.view.open('eikaiwa')}>{t('英会話')}</button>
              <button className="btn btn-mode" data-mode="vocab" onClick={() => void api.view.open('vocab')}>{t('語彙力特訓')}</button>
              <button className="btn btn-mode" data-mode="kanji" onClick={() => void api.view.open('kanji')}>{t('漢字特訓')}</button>
            </div>
          </section>

          <section className="card home-tools">
            <h2 className="section-title">{t('学びの道具')}</h2>
            <div className="home-progress-actions">
              <button className="btn btn-mode" data-mode="note" title={t('授業と関係なく使えるノート。名前を付けて、いくつでも作れます')} onClick={() => void api.view.open('memo')}>{t('メモ')}</button>
              <button className="btn btn-mode" data-mode="textbook" title={t('教科書・ノート・メモ・用語集から、言葉を探します')} onClick={() => void api.view.open('search')}>{t('検索')}</button>
              {getLang() === 'ja' && (
                <>
                  <button className="btn btn-mode" data-mode="textbook" title={t('あらゆる科目の用語の解説と、学ぶ学年・授業を調べます')} onClick={() => void api.view.open('glossary')}>{t('用語集')}</button>
                  <button className="btn btn-mode" data-mode="textbook" title={t('日本史と世界史のできごとを、年の順に見ます')} onClick={() => void api.view.open('timeline')}>{t('年表')}</button>
                </>
              )}
            </div>
          </section>

          <section className="card">
            <h2 className="section-title">{t('一緒に学ぶなかま')}</h2>
            <ul className="people">
              {characters.data?.map((c) => (
                <li key={c.id}>
                  <Portrait character={c} size="sm" />
                  <div className="people-info">
                    <strong>{c.name}</strong>
                    <small className="people-role">{c.roleLabel}</small>
                  </div>
                  <button className="btn btn-quiet" title={c.summary} onClick={() => setEditing(c)}>{t('設定')}</button>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2 className="section-title">{t('応答する AI')}</h2>
            <AiSettings compact />
          </section>

          <section className="card">
            <h2 className="section-title">{t('音声入力')}</h2>
            <SpeechSetup />
          </section>

          <section className="card home-settings">
            <h2 className="section-title">{t('表示とショートカット')}</h2>
            <p className="muted">{t('画面ごとの表示倍率（100%〜400%）と、ショートカットキーの割り当てを変えられます。')}</p>
            <button className="btn" onClick={() => void api.view.open('settings')}>{t('設定を開く')}</button>
          </section>
        </aside>
      </div>

      {editing && <CharacterEditor character={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
