import { useCallback, useEffect, useRef, useState } from 'react'
import type { TestFormat, TestQuestion, TestResult, TestSession, ViewParams } from '@shared/types'
import { CoursePicker } from '../components/CoursePicker'
import { Markdown } from '../components/Markdown'
import { Portrait } from '../components/Portrait'
import { MicButton } from '../components/MicButton'
import { EssayInput, WrittenInput } from '../components/WritingInput'
import { api, errorMessage, useLoad } from '../lib/hooks'
import { LOCALE, t, tx } from '@/lib/i18n'

const COUNTS = [5, 8, 10]
/** 形式（特化モード）ごとの、問題の数の選び方 */
const FORMAT_COUNTS: Record<TestFormat, number[]> = { mixed: COUNTS, choice: COUNTS, written: [3, 4, 5], essay: [1, 2, 3] }
const FORMATS: { id: TestFormat; label: string; hint: string }[] = [
  { id: 'mixed', label: t('いろいろ'), hint: t('選択・短答・記述を、とりまぜて出します。') },
  { id: 'choice', label: t('選択だけ'), hint: t('4 つの選択肢から選ぶ問題だけを出します。') },
  { id: 'written', label: t('記述だけ'), hint: t('100 字ほどで説明する問題だけを出します。') },
  { id: 'essay', label: t('論述だけ'), hint: t('序論・本論・結論で、数百〜千字で論じる問題だけを出します。') },
]
const LIMITS: { value: number | null; label: string }[] = [
  { value: null, label: t('計らない') },
  { value: 10, label: t('10 分') },
  { value: 20, label: t('20 分') },
  { value: 30, label: t('30 分') },
]
const KIND_LABEL: Record<TestQuestion['kind'], string> = { choice: t('選択'), short: t('短答'), written: t('記述'), essay: t('論述') }

const formatDate = (at: number) =>
  new Date(at).toLocaleString(LOCALE, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const formatClock = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * テストモード。AI が作った問題を解いて、学力を確かめる。
 * 受けている間は、教科書・ディベート・ほかのノートを開けない（メインプロセスが止める）。
 */
export function Test({ params }: { params: ViewParams }) {
  const [session, setSession] = useState<TestSession | null | undefined>(undefined)
  const [result, setResult] = useState<TestResult | null>(null)

  useEffect(() => {
    void api.test.active().then(setSession)
  }, [])
  // 成績の画面などから「この結果を見る」で開かれたとき
  useEffect(() => {
    if (params.testResultId) void api.test.result(params.testResultId).then(setResult)
  }, [params.testResultId])

  if (session === undefined) return null
  if (session) return <Taking session={session} onFinished={(r) => (setSession(null), setResult(r))} onAborted={() => setSession(null)} />
  if (result) return <Result result={result} onClose={() => setResult(null)} />
  return <Setup onStarted={setSession} onOpenResult={setResult} />
}

// ───────── 準備 ─────────

function Setup({ onStarted, onOpenResult }: { onStarted: (session: TestSession) => void; onOpenResult: (result: TestResult) => void }) {
  const courses = useLoad(() => api.content.courses(), [], ['content'])
  const settings = useLoad(() => api.settings.get(), [], [])
  const [pickedCourse, setPickedCourse] = useState<string | null>(null)
  // 本文がある授業を 1 つ以上持つ科目だけが、テストを受けられる
  const ready = (courses.data ?? []).filter((c) => c.ready > 0)
  const courseId = pickedCourse ?? (ready.find((c) => c.id === settings.data?.courseId) ?? ready[0])?.id ?? ''
  const curriculum = useLoad(() => (courseId ? api.content.curriculum(courseId) : Promise.resolve(null)), [courseId], ['content'])
  const results = useLoad(() => api.test.results(), [], ['test'])
  const [unitId, setUnitId] = useState('')
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [count, setCount] = useState(5)
  const [format, setFormat] = useState<TestFormat>('mixed')
  const [limit, setLimit] = useState<number | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 教科書が用意されている授業だけが出題範囲になる
  const units = (curriculum.data?.units ?? []).filter((u) => u.lessons.some((l) => l.status !== 'none'))
  const unit = units.find((u) => u.id === unitId) ?? units[0]
  const lessons = unit?.lessons.filter((l) => l.status !== 'none') ?? []
  const chosen = lessons.filter((l) => picked?.has(l.id) ?? true)

  const start = async () => {
    if (!unit || !chosen.length) return
    setStarting(true)
    setError(null)
    try {
      onStarted(await api.test.start({ courseId, unitId: unit.id, lessonIds: chosen.map((l) => l.id), questionCount: count, timeLimitMin: limit, format }))
    } catch (e) {
      setError(errorMessage(e))
      setStarting(false)
    }
  }

  return (
    <div className="test">
      <header className="view-header" data-mode="test">
        <div className="view-header-title">
          <small>{t('テスト')}</small>
          <strong>{t('テストの準備')}</strong>
        </div>
      </header>
      <div className="test-scroll">
        <div className="paper test-setup">
          {!unit ? (
            <p>{t('出題できる授業がまだありません。先に教科書を読んでみましょう。')}</p>
          ) : (
            <>
              <div className="field">
                <span>{t('科目')}</span>
                <CoursePicker
                  courses={courses.data ?? []}
                  value={courseId}
                  only={(c) => c.ready > 0 && c.subject !== 'moral'}
                  disabled={starting}
                  onChange={(id) => {
                    setPickedCourse(id)
                    setUnitId('')
                    setPicked(null)
                  }}
                />
              </div>

              <label className="field">
                <span>{t('単元')}</span>
                <select
                  value={unit.id}
                  disabled={starting}
                  onChange={(e) => {
                    setUnitId(e.target.value)
                    setPicked(null)
                  }}
                >
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.number} {u.title}
                    </option>
                  ))}
                </select>
              </label>

              <fieldset className="field">
                <legend>{t('出題する授業')}</legend>
                {lessons.map((l) => (
                  <label key={l.id} className="check">
                    <input
                      type="checkbox"
                      disabled={starting}
                      checked={picked?.has(l.id) ?? true}
                      onChange={(e) => {
                        const next = new Set(picked ?? lessons.map((r) => r.id))
                        if (e.target.checked) next.add(l.id)
                        else next.delete(l.id)
                        setPicked(next)
                      }}
                    />
                    {l.number} {l.title}
                  </label>
                ))}
              </fieldset>

              <div className="field">
                <span>{t('問題の形式')}</span>
                <div className="segmented">
                  {FORMATS.map((f) => (
                    <button
                      key={f.id}
                      disabled={starting}
                      aria-pressed={format === f.id}
                      title={f.hint}
                      onClick={() => {
                        setFormat(f.id)
                        if (!FORMAT_COUNTS[f.id].includes(count)) setCount(FORMAT_COUNTS[f.id][0])
                      }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <small className="muted">{FORMATS.find((f) => f.id === format)?.hint}</small>
              </div>

              <div className="field">
                <span>{t('問題の数')}</span>
                <div className="segmented">
                  {FORMAT_COUNTS[format].map((n) => (
                    <button key={n} disabled={starting} aria-pressed={count === n} onClick={() => setCount(n)}>
                      {tx('{0} 問', n)}</button>
                  ))}
                </div>
              </div>

              <div className="field">
                <span>{t('制限時間')}</span>
                <div className="segmented">
                  {LIMITS.map((l) => (
                    <button key={l.label} disabled={starting} aria-pressed={limit === l.value} onClick={() => setLimit(l.value)}>
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>

              <p className="notice">{t('テストの間は、教科書・ディベート・これまでのノートを開けません。開いているウィンドウは閉じられます。 計算には、テスト専用のノートを使えます。')}</p>
              {error && <p className="form-error">{error}</p>}
              <button className="btn btn-primary btn-wide" disabled={starting || !chosen.length} onClick={() => void start()}>
                {starting ? t('問題を作っています…（30 秒ほどかかります）') : t('テストを始める')}
              </button>
            </>
          )}
        </div>

        {!!results.data?.length && (
          <div className="paper test-history">
            <h2 className="section-title">{t('これまでのテスト')}</h2>
            <ul>
              {results.data.map((r) => (
                <li key={r.id}>
                  <button onClick={() => onOpenResult(r)}>
                    <span>{formatDate(r.finishedAt)}</span>
                    <strong>{r.unitTitle}</strong>
                    <span>{tx('{0} 問', r.results.length)}</span>
                    <b>{tx('{0} 点', r.score)}</b>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

// ───────── 受けている途中 ─────────

function Taking({
  session,
  onFinished,
  onAborted,
}: {
  session: TestSession
  onFinished: (result: TestResult) => void
  onAborted: () => void
}) {
  // 解答は入力のたびに保存しておき、ウィンドウを開き直しても続きから書けるようにする
  const storageKey = `manabi-test-${session.id}`
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, string>
    } catch {
      return {}
    }
  })
  const [now, setNow] = useState(Date.now())
  const [grading, setGrading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const answersRef = useRef(answers)
  answersRef.current = answers
  const submitted = useRef(false)

  const setAnswer = (id: string, value: string) => {
    const next = { ...answersRef.current, [id]: value }
    setAnswers(next)
    localStorage.setItem(storageKey, JSON.stringify(next))
  }

  const submit = useCallback(async () => {
    if (submitted.current) return
    submitted.current = true
    setGrading(true)
    setError(null)
    try {
      const result = await api.test.submit(answersRef.current)
      localStorage.removeItem(storageKey)
      onFinished(result)
    } catch (e) {
      submitted.current = false
      setError(errorMessage(e))
      setGrading(false)
    }
  }, [onFinished, storageKey])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [])

  const deadline = session.timeLimitMin ? session.startedAt + session.timeLimitMin * 60_000 : null
  const remaining = deadline === null ? null : deadline - now
  // 時間になったら、そのときの解答で提出する
  useEffect(() => {
    if (remaining !== null && remaining <= 0) void submit()
  }, [remaining, submit])

  const answered = session.questions.filter((q) => (answers[q.id] ?? '').trim() !== '').length
  const confirmSubmit = () => {
    const blank = session.questions.length - answered
    if (blank > 0 && !window.confirm(t('まだ答えていない問題が {0} 問あります。提出しますか？', blank))) return
    void submit()
  }
  const abort = async () => {
    if (!window.confirm(t('テストをやめますか？ やめると採点されず、記録にも残りません。'))) return
    await api.test.abort()
    localStorage.removeItem(storageKey)
    onAborted()
  }

  return (
    <div className="test">
      <header className="view-header" data-mode="test">
        <div className="view-header-title">
          <small>{t('テスト中')}</small>
          <strong>{session.unitTitle}</strong>
        </div>
        <div className="test-status">
          <span>{tx('解答 {0} / {1}', answered, session.questions.length)}
          </span>
          <span className="test-clock" data-urgent={remaining !== null && remaining < 60_000}>
            {remaining === null ? t('経過 {0}', formatClock(now - session.startedAt)) : t('残り {0}', formatClock(remaining))}
          </span>
        </div>
        <div className="view-header-actions">
          <button className="btn btn-mode" data-mode="note" disabled={grading} onClick={() => void api.view.open('note', { notebookId: session.notebookId })}>{t('計算用ノート')}</button>
          <button className="btn btn-quiet" disabled={grading} onClick={() => void abort()}>{t('やめる')}</button>
          <button className="btn btn-primary" disabled={grading} onClick={confirmSubmit}>{t('提出する')}</button>
        </div>
      </header>

      <div className="test-scroll">
        {grading ? (
          <div className="paper paper-empty">
            <h2>{t('採点しています…')}</h2>
            <p className="muted">{t('30 秒ほどかかります。')}</p>
          </div>
        ) : (
          <ol className="questions">
            {session.questions.map((q, i) => (
              <li key={q.id} className="paper question">
                <div className="question-head">
                  <span className="question-number">{tx('問 {0}', i + 1)}</span>
                  <span className="chip">{KIND_LABEL[q.kind]}</span>
                  <span className="question-points">{tx('{0} 点', q.points)}</span>
                </div>
                <Markdown>{q.prompt}</Markdown>
                {q.kind === 'choice' ? (
                  <div className="choices" role="radiogroup" aria-label={t('問 {0} の選択肢', i + 1)}>
                    {q.choices.map((choice, index) => (
                      <label key={index} className="choice" data-picked={answers[q.id] === String(index)}>
                        <input type="radio" name={q.id} checked={answers[q.id] === String(index)} onChange={() => setAnswer(q.id, String(index))} />
                        <Markdown>{choice}</Markdown>
                      </label>
                    ))}
                  </div>
                ) : q.kind === 'short' ? (
                  <input
                    className="answer"
                    type="text"
                    value={answers[q.id] ?? ''}
                    placeholder={t('答えを入力')}
                    spellCheck={false}
                    maxLength={200}
                    aria-label={t('問 {0} の答え', i + 1)}
                    onChange={(e) => setAnswer(q.id, e.target.value)}
                  />
                ) : q.kind === 'essay' ? (
                  <EssayInput value={answers[q.id] ?? ''} onChange={(value) => setAnswer(q.id, value)} min={session.lengths?.essay[0] ?? 500} max={session.lengths?.essay[1] ?? 1000} label={t('問 {0} の答え', i + 1)} />
                ) : session.format === 'written' ? (
                  <WrittenInput value={answers[q.id] ?? ''} onChange={(value) => setAnswer(q.id, value)} min={session.lengths?.written[0] ?? 80} max={session.lengths?.written[1] ?? 140} label={t('問 {0} の答え', i + 1)} />
                ) : (
                  <div className="answer-row">
                    <textarea
                      className="answer"
                      rows={3}
                      value={answers[q.id] ?? ''}
                      placeholder={t('自分の言葉で説明しましょう')}
                      maxLength={1000}
                      aria-label={t('問 {0} の答え', i + 1)}
                      onChange={(e) => setAnswer(q.id, e.target.value)}
                    />
                    <MicButton label={t('マイクで話して答える')} onText={(text) => setAnswer(q.id, `${answers[q.id] ?? ''}${text}`.slice(0, 1000))} />
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
        {error && <p className="form-error">{error}</p>}
      </div>
    </div>
  )
}

// ───────── 結果 ─────────

function mark(score: number, points: number): { symbol: string; label: string; kind: string } {
  if (score >= points) return { symbol: '○', label: t('正解'), kind: 'good' }
  if (score > 0) return { symbol: '△', label: t('部分点'), kind: 'partial' }
  return { symbol: '×', label: t('不正解'), kind: 'bad' }
}

function Result({ result, onClose }: { result: TestResult; onClose: () => void }) {
  const characters = useLoad(() => api.characters.list(), [], ['characters'])
  const teacher = characters.data?.find((c) => c.role === 'teacher')
  // 点が低いときも、困った顔は見せない（先生は、責めずに見守る）
  const face = result.score >= 80 ? 'praise' : result.score >= 60 ? 'smile' : result.score >= 40 ? 'thinking' : 'gentle'
  const minutes = Math.max(1, Math.round((result.finishedAt - result.startedAt) / 60_000))

  return (
    <div className="test">
      <header className="view-header" data-mode="test">
        <div className="view-header-title">
          <small>{t('テストの結果')}</small>
          <strong>{result.unitTitle}</strong>
        </div>
        <div className="view-header-actions">
          <button className="btn btn-mode" data-mode="note" onClick={() => void api.view.open('note', { notebookId: result.notebookId })}>{t('計算用ノートを見る')}</button>
          <button className="btn" onClick={() => void api.view.open('report')}>{t('成績を見る')}</button>
          <button className="btn" onClick={() => void api.view.open('home')}>{t('ホームへ')}</button>
          <button className="btn btn-primary" onClick={onClose}>{t('もう一度受ける')}</button>
        </div>
      </header>

      <div className="test-scroll">
        <div className="paper test-score">
          <div className="hero-figure">
            <strong>{result.score}</strong>
            <span>{t('点 / 100')}</span>
          </div>
          <div className="test-score-comment">
            {teacher && <Portrait character={teacher} expression={face} size="md" />}
            <div className="bubble bubble-right">
              <Markdown>{result.comment}</Markdown>
            </div>
          </div>
          <p className="muted">
            {tx('{0} ／ {1} 問 ／ かかった時間 約 {2} 分{3}', formatDate(result.finishedAt), result.results.length, minutes, result.timeLimitMin ? t('（制限 {0} 分）', result.timeLimitMin) : '')}
          </p>
        </div>

        <ol className="questions">
          {result.results.map((r, i) => {
            const m = mark(r.score, r.question.points)
            return (
              <li key={r.question.id} className="paper question">
                <div className="question-head">
                  <span className="question-number">{tx('問 {0}', i + 1)}</span>
                  <span className="result-mark" data-kind={m.kind}>
                    <b aria-hidden>{m.symbol}</b>
                    {m.label}
                  </span>
                  <span className="question-points">
                    {tx('{0} / {1} 点', r.score, r.question.points)}</span>
                </div>
                <Markdown>{r.question.prompt}</Markdown>
                <dl className="answer-review">
                  <dt>{t('あなたの答え')}</dt>
                  <dd>{r.answer ? <Markdown>{r.answer}</Markdown> : <span className="muted">{t('（無回答）')}</span>}</dd>
                  <dt>{t('正しい答え')}</dt>
                  <dd>
                    <Markdown>{r.correctAnswer}</Markdown>
                  </dd>
                </dl>
                {r.feedback && <Markdown className="result-feedback">{r.feedback}</Markdown>}
                <details className="result-explanation">
                  <summary>{t('解き方を見る')}</summary>
                  <Markdown>{r.explanation}</Markdown>
                </details>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
