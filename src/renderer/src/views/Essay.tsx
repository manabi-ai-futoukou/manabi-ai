import { useEffect, useState } from 'react'
import { ESSAY_PARTS, countChars, splitEssay, writingTargets, type EssayParts } from '@shared/essay'
import type { EssayAttempt, LessonVariant, ViewParams } from '@shared/types'
import { CoursePicker } from '../components/CoursePicker'
import { Markdown } from '../components/Markdown'
import { PinButton } from '../components/PinButton'
import { Portrait } from '../components/Portrait'
import { EssayInput, PART_TEXT, WrittenInput } from '../components/WritingInput'
import { api, errorMessage, useLoad } from '../lib/hooks'
import { LOCALE, getLang, t, tx } from '@/lib/i18n'

type Kind = 'short' | 'long'
const courseOf = (lessonId: string) => lessonId.replace(/-\d+-\d+$/, '')
const formatDate = (at: number) => new Date(at).toLocaleString(LOCALE, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const draftKey = (lessonId: string, kind: Kind, slot: string) => `manabi-essay:${lessonId}:${kind}:${slot}`

/**
 * 記述・論述の練習モード。
 *   記述 … 100 字ほどを目安に、短く説明する
 *   論述 … 数百〜千字を目安に、序論・本論・結論を書く
 * 問題は、AI が前もって作ったもの（解答例つき）を出すことも、自分でテーマを決めることもできる。
 * 解答例は、見たいときだけ表示する。書いた文章は、先生（AI）に講評してもらえる。
 */
export function Essay({ params }: { params: ViewParams }) {
  const settings = useLoad(() => api.settings.get(), [], [])
  const courses = useLoad(() => api.content.courses(), [], ['content'])
  const characters = useLoad(() => api.characters.list(), [], ['characters'])
  const teacher = characters.data?.find((c) => c.role === 'teacher')
  const [pickedCourse, setPickedCourse] = useState<string | null>(null)
  const [lessonId, setLessonId] = useState(params.lessonId ?? '')
  const variant: LessonVariant = params.variant ?? 'standard'
  const ready = (courses.data ?? []).filter((c) => c.ready > 0)
  const courseId = pickedCourse ?? (lessonId ? courseOf(lessonId) : ((ready.find((c) => c.id === settings.data?.courseId) ?? ready[0])?.id ?? ''))
  const course = courses.data?.find((c) => c.id === courseId)
  const curriculum = useLoad(() => (courseId ? api.content.curriculum(courseId) : Promise.resolve(null)), [courseId], ['content'])
  const lessons = (curriculum.data?.units ?? []).flatMap((u) => u.lessons.filter((l) => l.status !== 'none' || l.deep).map((l) => ({ ...l, unitTitle: u.title })))
  const problems = useLoad(() => (lessonId ? api.essay.get(lessonId, variant) : Promise.resolve(null)), [lessonId, variant], ['essay'])
  const history = useLoad(() => (lessonId ? api.essay.attempts(lessonId) : Promise.resolve([])), [lessonId], ['essay'])

  const [kind, setKind] = useState<Kind>('short')
  /** どの問題か（AI が作った問題の番号。'own' は、自分で決めたテーマ） */
  const [slot, setSlot] = useState('0')
  const [ownQuestion, setOwnQuestion] = useState('')
  const [text, setText] = useState('')
  const [showProblem, setShowProblem] = useState(true)
  const [showAnswer, setShowAnswer] = useState(false)
  const [making, setMaking] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [review, setReview] = useState<EssayAttempt | null>(null)

  useEffect(() => {
    if (params.lessonId) {
      setLessonId(params.lessonId)
      setPickedCourse(null)
    }
  }, [params.lessonId])
  // 科目を選んだら、そのはじめの授業にする
  useEffect(() => {
    if (lessons.length && (!lessonId || courseOf(lessonId) !== courseId)) setLessonId(lessons[0].id)
  }, [lessonId, courseId, lessons.length])
  // 授業・種類・問題を変えたら、その下書きを読みこむ
  useEffect(() => {
    setShowAnswer(false)
    setReview(null)
    setError(null)
    try {
      setText(localStorage.getItem(draftKey(lessonId, kind, slot)) ?? '')
      if (slot === 'own') setOwnQuestion(localStorage.getItem(`${draftKey(lessonId, kind, slot)}:q`) ?? '')
    } catch {
      setText('')
    }
  }, [lessonId, kind, slot])

  const grade = course?.school === 'es' ? Number(/(\d) 年$/.exec(course.label)?.[1] ?? 6) : null
  const targets = writingTargets(course?.school ?? 'hs', grade)
  const list = kind === 'short' ? (problems.data?.short ?? []) : (problems.data?.long ?? [])
  const problem = slot === 'own' ? null : list[Number(slot)]
  const question = slot === 'own' ? ownQuestion.trim() : (problem?.question ?? '')
  const write = (value: string) => {
    setText(value)
    try {
      localStorage.setItem(draftKey(lessonId, kind, slot), value)
    } catch {
      // 下書きを残せなくても、書くことはできる
    }
  }
  const make = async () => {
    setMaking(true)
    setError(null)
    try {
      await api.essay.make(lessonId, variant)
      problems.reload()
      setSlot('0')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setMaking(false)
    }
  }
  const ask = async () => {
    setReviewing(true)
    setError(null)
    try {
      const parts = splitEssay(text)
      setReview(await api.essay.review({ lessonId, variant, kind, question, points: problem?.points, ...(kind === 'long' ? { parts } : { text }) }))
      history.reload()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setReviewing(false)
    }
  }
  const written = countChars(kind === 'long' ? Object.values(splitEssay(text)).join('') : text)

  return (
    <div className="essay">
      <header className="view-header" data-mode="test">
        <div className="view-header-title">
          <small>{t('書いて説明する力をのばす')}</small>
          <strong>{t('記述・論述の練習')}</strong>
        </div>
        <div className="view-header-actions">
          <div className="segmented" role="group" aria-label={t('練習の種類')}>
            <button aria-pressed={kind === 'short'} onClick={() => (setKind('short'), setSlot('0'))}>{tx('記述（{0} 字ほど）', targets.short[1])}</button>
            <button aria-pressed={kind === 'long'} onClick={() => (setKind('long'), setSlot('0'))}>{tx('論述（{0}〜{1} 字）', targets.long[0], targets.long[1])}</button>
          </div>
          <PinButton className="btn btn-quiet" />
        </div>
      </header>

      <div className="essay-body">
        <section className="card essay-pick">
          <div className="field">
            <span>{t('科目')}</span>
            <CoursePicker courses={courses.data ?? []} value={courseId} only={(c) => c.ready > 0} onChange={(id) => (setPickedCourse(id), setLessonId(''))} />
          </div>
          <label className="field">
            <span>{t('授業')}</span>
            <select value={lessonId} onChange={(e) => setLessonId(e.target.value)}>
              {lessons.map((l) => (
                <option key={l.id} value={l.id}>{l.number} {l.title}</option>
              ))}
            </select>
          </label>
          <div className="essay-pick-actions">
            <button className="btn btn-mode" data-mode="textbook" disabled={!lessonId} onClick={() => void api.view.open('textbook', { lessonId, variant })}>{t('教科書を開く')}</button>
          </div>
        </section>

        <section className="card essay-problem">
          <div className="essay-slots">
            <div className="chips" role="group" aria-label={t('問題')}>
              {list.map((_, i) => (
                <button key={i} className="chip-toggle" aria-pressed={slot === String(i)} onClick={() => setSlot(String(i))}>{tx('AI が作った問題 {0}', i + 1)}</button>
              ))}
              <button className="chip-toggle" aria-pressed={slot === 'own'} onClick={() => setSlot('own')}>{t('自分でテーマを決める')}</button>
            </div>
            {slot !== 'own' && problem && <button className="btn btn-quiet" onClick={() => setShowProblem((on) => !on)}>{showProblem ? t('問題をかくす') : t('問題を表示する')}</button>}
          </div>

          {slot === 'own' ? (
            <label className="field">
              <span>{t('テーマ（自分で決めた問い）')}</span>
              <textarea
                rows={2}
                value={ownQuestion}
                maxLength={400}
                placeholder={kind === 'short' ? t('例: 光合成のしくみを、100 字ほどで説明する。') : t('例: 江戸幕府が 260 年あまり続いた理由を、政治のしくみに注目して論じる。')}
                onChange={(e) => {
                  setOwnQuestion(e.target.value)
                  try {
                    localStorage.setItem(`${draftKey(lessonId, kind, slot)}:q`, e.target.value)
                  } catch {
                    // 下書きを残せなくても、書くことはできる
                  }
                }}
              />
            </label>
          ) : problem ? (
            showProblem && <Markdown className="essay-question">{problem.question}</Markdown>
          ) : getLang() !== 'ja' ? (
            <p className="muted">{t('AI の問題は、日本語で表示しているときに使えます。「自分でテーマを決める」は、どの言語でも使えます。')}</p>
          ) : (
            <div className="essay-make">
              <p className="muted">{t('この授業の、AI が作った問題と解答例は、まだありません。')}</p>
              <button className="btn btn-primary" disabled={making || !lessonId} onClick={() => void make()}>{making ? t('AI が問題を作っています…（30 秒ほどかかります）') : t('AI に、問題と解答例を作ってもらう')}</button>
            </div>
          )}
        </section>

        <section className="card essay-write">
          <h2 className="section-title">{kind === 'short' ? t('記述する') : t('論述する（序論・本論・結論）')}</h2>
          {kind === 'short' ? (
            <WrittenInput value={text} onChange={write} min={targets.short[0]} max={targets.short[2]} label={t('記述の答え')} disabled={reviewing} />
          ) : (
            <EssayInput value={text} onChange={write} min={targets.long[0]} max={targets.long[1]} label={t('論述の答え')} disabled={reviewing} />
          )}
          <div className="essay-actions">
            <button className="btn btn-primary" disabled={reviewing || !written || !question} title={question ? undefined : t('問題（テーマ）を決めてください')} onClick={() => void ask()}>
              {reviewing ? t('読んでいます…（30 秒ほどかかります）') : tx('{0}に見てもらう', teacher?.name ?? t('先生'))}
            </button>
            {problem && <button className="btn" aria-pressed={showAnswer} onClick={() => setShowAnswer((on) => !on)}>{showAnswer ? t('解答例をかくす') : t('解答例を表示する')}</button>}
            <button className="btn btn-quiet" disabled={!text || reviewing} onClick={() => window.confirm(t('書いた文章を消します。よろしいですか？')) && write('')}>{t('書いた文章を消す')}</button>
          </div>
          {error && <p className="form-error">{error}</p>}
        </section>

        {showAnswer && problem && (
          <section className="card essay-answer">
            <h2 className="section-title">{t('解答例')}</h2>
            {kind === 'short' ? (
              <Markdown>{String(problem.answer)}</Markdown>
            ) : (
              ESSAY_PARTS.map((part) => (
                <div key={part.id} className="essay-answer-part">
                  <strong>{PART_TEXT[part.id].label}</strong>
                  <Markdown>{(problem.answer as EssayParts)[part.id]}</Markdown>
                </div>
              ))
            )}
            {problem.points.length > 0 && (
              <>
                <h3>{t('採点で見る要点')}</h3>
                <ul className="essay-points">{problem.points.map((p, i) => <li key={i}>{p}</li>)}</ul>
              </>
            )}
            <p className="muted">{t('解答例は、AI が授業の本文をもとに作った「一つの例」です。書き方は、ほかにもあります。')}</p>
          </section>
        )}

        {review && (
          <section className="card essay-review">
            <h2 className="section-title">{t('先生の講評')}</h2>
            <div className="essay-review-head">
              {teacher && <Portrait character={teacher} expression={review.score >= 80 ? 'praise' : review.score >= 60 ? 'smile' : review.score >= 40 ? 'thinking' : 'gentle'} size="md" />}
              <div className="hero-figure"><strong>{review.score}</strong><span>{t('点 / 100')}</span></div>
            </div>
            <dl className="essay-review-body">
              <dt>{t('よく書けているところ')}</dt>
              <dd><Markdown>{review.good}</Markdown></dd>
              <dt>{t('直すとよいところ')}</dt>
              <dd><Markdown>{review.improve}</Markdown></dd>
              {review.example && (
                <>
                  <dt>{t('直し方の例')}</dt>
                  <dd><Markdown>{review.example}</Markdown></dd>
                </>
              )}
            </dl>
          </section>
        )}

        {!!history.data?.length && (
          <section className="card essay-history">
            <h2 className="section-title">{t('この授業で、これまでに見てもらった文章')}</h2>
            <ul>
              {history.data.slice(0, 12).map((a) => (
                <li key={a.id}>
                  <button onClick={() => setReview(a)}>
                    <span>{formatDate(a.at)}</span>
                    <span className="chip">{a.kind === 'long' ? t('論述') : t('記述')}</span>
                    <strong>{a.question}</strong>
                    <b>{tx('{0} 点', a.score)}</b>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
