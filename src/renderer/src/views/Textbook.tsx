import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { hasBlock } from '@shared/blocks'
import { simsFor } from '@shared/sims'
import { hasTalk } from '@shared/talk'
import type { LessonVariant, ViewParams } from '@shared/types'
import { CoursePicker, FieldNote } from '../components/CoursePicker'
import { Markdown } from '../components/Markdown'
import { PinButton } from '../components/PinButton'
import { AnnotationContext, annotateOptions } from '../lib/annotateText'
import { api, errorMessage, useLoad, usePhone } from '../lib/hooks'
import { getLang, t, tx } from '@/lib/i18n'

/** 授業の ID（<科目>-<単元>-<授業>）から、科目の ID を取り出す */
const courseOf = (lessonId: string) => lessonId.replace(/-\d+-\d+$/, '')
/** 日本語（教材の原本の言語）で表示しているか。授業を作る・掛け合いや図解を足す操作は、このときだけ出す */
const SOURCE = getLang() === 'ja'
const SOURCE_ONLY = () => <p className="muted">{t('授業の作成は、日本語で表示しているときに行います。設定で言語を切りかえてください。')}</p>
/** 教科書モード。授業の本文を読み、気になったところを選んで質問できる。 */
export function Textbook({ params }: { params: ViewParams }) {
  const settings = useLoad(() => api.settings.get(), [], ['settings'])
  const courses = useLoad(() => api.content.courses(), [], ['content'])
  const [lessonId, setLessonId] = useState(params.lessonId ?? '')
  const [pickedCourse, setPickedCourse] = useState<string | null>(null)
  const [variant, setVariant] = useState<LessonVariant>(params.variant ?? 'standard')
  const courseId = pickedCourse ?? (lessonId ? courseOf(lessonId) : (settings.data?.courseId ?? ''))
  const course = courses.data?.find((c) => c.id === courseId)
  const curriculum = useLoad(() => (courseId ? api.content.curriculum(courseId) : Promise.resolve(null)), [courseId], ['content'])
  const shown: LessonVariant = course?.hasDeep ? variant : 'standard'
  const lesson = useLoad(() => (lessonId ? api.content.lesson(lessonId, shown) : Promise.resolve(null)), [lessonId, shown], ['content'])
  // 動画（試作）がある授業にだけ、動画への入り口を出す
  const video = useLoad(() => (lessonId ? api.video.get(lessonId, shown) : Promise.resolve(null)), [lessonId, shown], ['video'])
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  // 授業を開いたら、その授業のノートも、利き手の側に開く（スマートフォンや、せまい画面では開かない）
  const phone = usePhone()
  const handedness = settings.data?.handedness
  useEffect(() => {
    if (!lessonId || !handedness || phone || window.screen.width < 900) return
    void api.view.open('note', { lessonId, beside: handedness === 'left' ? 'left' : 'right' }).catch(() => undefined)
  }, [lessonId, handedness, phone])
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null)
  const articleRef = useRef<HTMLElement>(null)
  // 用語・ふりがな・前提と関連（日本語で表示しているときだけ。まだ作られていない授業では null）
  const annotation = useLoad(() => (lessonId && SOURCE ? api.annot.get(lessonId, shown) : Promise.resolve(null)), [lessonId, shown], ['annot'])
  const links = useLoad(() => (lessonId && SOURCE ? api.annot.links(lessonId, shown) : Promise.resolve(null)), [lessonId, shown], ['annot'])
  const furigana = SOURCE && (settings.data?.furigana ?? true)
  const marks = useMemo(() => annotateOptions(annotation.data, furigana), [annotation.data, furigana])
  /** 押した用語の、簡単な解説（用語の近くに出す） */
  const [termCard, setTermCard] = useState<{ term: string; x: number; y: number } | null>(null)
  /** 赤シート: 太字の大事な言葉をかくす（押すと、その言葉だけ見える） */
  const [redSheet, setRedSheet] = useState(false)
  /** スマートフォンでは、授業の一覧をたたんでおき、押したら全画面で開く */
  const [navOpen, setNavOpen] = useState(false)

  useEffect(() => {
    if (!params.lessonId) return
    setLessonId(params.lessonId)
    setPickedCourse(null)
    if (params.variant) setVariant(params.variant)
  }, [params.lessonId, params.variant])

  // 科目を開いたら、その最初の授業を表示する
  const units = curriculum.data?.units ?? []
  useEffect(() => {
    const first = units[0]?.lessons[0]
    if (first && (!lessonId || courseOf(lessonId) !== courseId)) setLessonId(first.id)
  }, [lessonId, courseId, units])

  useEffect(() => {
    articleRef.current?.scrollTo({ top: 0 })
    setSelection(null)
    setTermCard(null)
    setError(null)
    setInfo(null)
    // いま読んでいる授業を知らせる（学習時間を、どの教科のものとして数えるかに使われる）
    if (lessonId) void api.view.context({ lessonId })
  }, [lessonId, shown])

  const unit = units.find((u) => u.lessons.some((l) => l.id === lessonId))
  const meta = unit?.lessons.find((l) => l.id === lessonId)
  const index = unit?.lessons.findIndex((l) => l.id === lessonId) ?? -1
  const next = unit && index >= 0 ? unit.lessons[index + 1] : undefined

  const run = async (work: () => Promise<unknown>) => {
    setGenerating(true)
    setError(null)
    setInfo(null)
    try {
      await work()
      curriculum.reload()
      lesson.reload()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setGenerating(false)
    }
  }

  /** 本文を押したとき: 赤シートでかくした言葉なら見せる。用語なら、簡単な解説を出す */
  const onArticleClick = (e: ReactMouseEvent<HTMLElement>) => {
    const target = e.target as HTMLElement
    const hidden = redSheet ? target.closest<HTMLElement>('.md strong') : null
    if (hidden) {
      hidden.toggleAttribute('data-shown')
      return setTermCard(null)
    }
    const term = target.closest<HTMLElement>('.gterm')
    if (!term?.dataset['term'] || window.getSelection()?.toString()) return setTermCard(null)
    const rect = term.getBoundingClientRect()
    setTermCard({ term: term.dataset['term'], x: rect.left + rect.width / 2, y: rect.bottom + 6 })
  }
  /** 赤シートでかくした言葉を、まとめて見せる・かくす */
  const revealAll = (shown: boolean) => articleRef.current?.querySelectorAll('.md strong').forEach((el) => el.toggleAttribute('data-shown', shown))
  const termInfo = termCard ? annotation.data?.terms.find((x) => x.term === termCard.term) : undefined
  const openLesson = (id: string, lessonVariant: LessonVariant) => {
    setLessonId(id)
    setPickedCourse(null)
    setVariant(lessonVariant)
  }

  /** 本文で文字を選んだら、その近くに「この部分を質問する」ボタンを出す */
  const onMouseUp = () => {
    const picked = window.getSelection()
    const text = picked?.toString().trim() ?? ''
    if (!picked || picked.rangeCount === 0 || text.length < 2 || text.length > 300) return setSelection(null)
    const rect = picked.getRangeAt(0).getBoundingClientRect()
    setSelection({ text, x: rect.left + rect.width / 2, y: rect.bottom + 8 })
  }

  return (
    <div className="textbook" data-nav={navOpen ? 'open' : undefined}>
      <nav className="textbook-nav" aria-label={t('授業の一覧')}>
        <button className="btn textbook-nav-close" onClick={() => setNavOpen(false)}>{t('× 一覧を閉じる')}</button>
        {courses.data && (
          <CoursePicker
            courses={courses.data}
            value={courseId}
            disabled={generating}
            onChange={(id) => {
              setPickedCourse(id)
              setLessonId('')
            }}
          />
        )}
        {units.map((u) => (
          <details key={u.id} open={u.id === unit?.id}>
            <summary>
              <span className="unit-number">{u.number}</span>
              {u.title}
            </summary>
            <ul>
              {u.lessons.map((l) => (
                <li key={l.id}>
                  <button
                    className={l.id === lessonId ? 'nav-item nav-item-active' : 'nav-item'}
                    data-status={l.status}
                    onClick={() => {
                      setLessonId(l.id)
                      setNavOpen(false)
                    }}
                  >
                    <span>{l.number}</span>
                    {l.title}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </nav>

      <div className="textbook-main">
        <header className="view-header" data-mode="textbook">
          <div className="view-header-title">
            <small>{course ? `${course.title}${unit ? ` ／ ${unit.number} ${unit.title}` : ''}` : ''}</small>
            <strong>{meta ? `${meta.number} ${meta.title}` : t('教科書')}</strong>
          </div>
          <div className="view-header-actions">
            <button className="btn phone-only" onClick={() => setNavOpen(true)}>{t('≡ 授業の一覧')}</button>
            {course?.hasDeep && (
              <div className="segmented" aria-label={t('本文の種類')}>
                <button aria-pressed={shown === 'standard'} disabled={generating} onClick={() => setVariant('standard')}>{t('小学生向け')}</button>
                <button aria-pressed={shown === 'deep'} disabled={generating} onClick={() => setVariant('deep')}>{t('学び直し（深掘り）')}</button>
              </div>
            )}
            {SOURCE && (
              <>
                <button className="btn btn-toggle" aria-pressed={furigana} title={t('むずかしい言葉や名前に、ふりがなを出します')} onClick={() => void api.settings.set({ furigana: !furigana }).then(() => settings.reload())}>{t('ふりがな')}</button>
                <button className="btn btn-toggle btn-redsheet" aria-pressed={redSheet} disabled={!lesson.data} title={t('太字の大事な言葉を、赤いシートでかくします。押すと、その言葉だけ見えます')} onClick={() => setRedSheet((on) => !on)}>{t('赤シート')}</button>
              </>
            )}
            <button className="btn btn-mode" data-mode="chat" disabled={!lesson.data} onClick={() => void api.view.open('chat', { lessonId })}>{t('質問する')}</button>
            <button className="btn btn-mode" data-mode="note" disabled={!lessonId} onClick={() => void api.view.open('note', { lessonId })}>{t('ノートを開く')}</button>
            <PinButton className="btn btn-quiet" />
          </div>
        </header>

        {redSheet && lesson.data && (
          <p className="redsheet-bar" role="status">
            <span>{t('赤シート: 太字の言葉をかくしています。言葉を押すと、その言葉だけ見えます。')}</span>
            <button className="btn" onClick={() => revealAll(true)}>{t('すべて見せる')}</button>
            <button className="btn" onClick={() => revealAll(false)}>{t('すべてかくす')}</button>
            <button className="btn btn-quiet" onClick={() => setRedSheet(false)}>{t('赤シートをやめる')}</button>
          </p>
        )}
        <article
          className="textbook-article"
          ref={articleRef}
          data-redsheet={redSheet ? 'on' : undefined}
          onMouseUp={onMouseUp}
          onClick={onArticleClick}
          onScroll={() => {
            setSelection(null)
            setTermCard(null)
          }}
        >
          {course && curriculum.data === null ? (
            <div className="paper paper-empty">
              <h2>{course.title}</h2>
              <p>{t('この科目の単元表は、まだ作られていません。')}</p>
              {SOURCE ? (
                <button className="btn btn-primary" disabled={generating} onClick={() => void run(() => api.content.ensureCurriculum(courseId))}>
                  {generating ? t('単元表を作っています…（30 秒ほどかかります）') : t('AI に単元表を作ってもらう')}
                </button>
              ) : (
                <SOURCE_ONLY />
              )}
              {error && <p className="form-error">{error}</p>}
            </div>
          ) : lesson.data ? (
            <div className="paper">
              {lesson.data.status !== 'authored' || lesson.data.variant === 'deep' ? (
                <p className="notice">{tx('この授業は AI が作成しました{0}。人の目による確認はまだ行われていません。 おかしいと感じたところは、先生に質問して確かめてください。', lesson.data.reviewed ? t('（作成後に、AI がもう一度点検しています）') : '')}{lesson.data.externalReview && (
                    <span className="notice-review">
                      {tx('{0} に {1} が精査しました{2}。', new Date(lesson.data.externalReview.at).toLocaleDateString(getLang() === 'ja' ? 'ja-JP' : getLang()), lesson.data.externalReview.by, lesson.data.externalReview.verdict === 'fixed' ? t('（修正あり）') : lesson.data.externalReview.verdict === 'flag' ? t('（確認が必要な点あり）') : '')}</span>
                  )}
                </p>
              ) : null}
              {lesson.data.untranslated && (
                <p className="notice">
                  {t('この授業は、まだ訳されていません。日本語のまま表示しています。')}{' '}
                  <button className="btn" disabled={generating} onClick={() => void run(() => api.content.translate(lessonId, shown))}>
                    {generating ? t('訳しています…（1 分ほどかかります）') : t('AI にこの授業を訳してもらう')}
                  </button>
                </p>
              )}
              {lesson.data.outdated && <p className="notice">{t('この授業の日本語版は、訳したあとに書き直されました。表示している訳は、書き直す前の内容です。日本語版とは、内容が異なります。')}</p>}
              {course && <FieldNote course={course} />}
              <AnnotationContext.Provider value={marks}>
                <Markdown>{lesson.data.body}</Markdown>
              </AnnotationContext.Provider>
              {links.data && (links.data.prerequisites.length > 0 || links.data.related.length > 0) && (
                <section className="lesson-links" aria-label={t('関連する授業')}>
                  {(
                    [
                      [t('この授業の前に（土台になる授業）'), links.data.prerequisites],
                      [t('関連する授業'), links.data.related],
                    ] as const
                  ).map(
                    ([title, list]) =>
                      list.length > 0 && (
                        <div key={title}>
                          <h3>{title}</h3>
                          <ul>
                            {list.map((link) => (
                              <li key={link.lessonId}>
                                <button className="lesson-link" title={t('この授業を開く')} onClick={() => openLesson(link.lessonId, link.variant)}>
                                  <small>{link.courseTitle}</small>
                                  <strong>{link.number} {link.title}</strong>
                                  <span className="chip">{link.via}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ),
                  )}
                </section>
              )}
              <footer className="paper-footer">
                <button className="btn btn-mode" data-mode="chat" onClick={() => void api.view.open('chat', { lessonId })}>{t('わからないところを質問する')}</button>
                <button className="btn btn-mode" data-mode="note" onClick={() => void api.view.open('note', { lessonId })}>{t('自分の言葉でノートにまとめる')}</button>
                <button className="btn btn-mode" data-mode="test" title={t('この授業の内容で、記述（100 字ほど）と論述（序論・本論・結論）を練習します')} onClick={() => void api.view.open('essay', { lessonId, variant: shown })}>{t('記述・論述を練習する')}</button>
                {next && (
                  <button className="btn" onClick={() => setLessonId(next.id)}>{tx('次の授業へ: {0} {1}', next.number, next.title)}
                  </button>
                )}
                {api.authoring && SOURCE && course?.subject !== 'moral' && (lesson.data.status !== 'authored' || lesson.data.variant === 'deep') && (
                  <button
                    className="btn btn-quiet"
                    disabled={generating}
                    title={t('先生と同級生の短い会話を、本文の前と確かめ問題の前に入れます（本文は変わりません）')}
                    onClick={() => void run(() => api.content.talk(lessonId, shown, hasTalk(lesson.data?.body ?? '')))}
                  >
                    {generating ? t('掛け合いを書いています…（30 秒ほどかかります）') : hasTalk(lesson.data.body) ? t('掛け合いを作り直す') : t('AI に掛け合いを足してもらう')}
                  </button>
                )}
                {api.authoring && SOURCE && course && simsFor(course).length > 0 && (lesson.data.status !== 'authored' || lesson.data.variant === 'deep') && (
                  <button
                    className="btn btn-quiet"
                    disabled={generating}
                    title={t('条件を自分で変えて確かめられる図を、合うものがあれば本文に入れます（本文は変わりません）')}
                    onClick={() =>
                      void run(async () => {
                        const result = await api.content.sim(lessonId, shown, hasBlock(lesson.data?.body ?? '', 'sim'))
                        if (!result.added) setInfo(t('この授業に合う動く図解は、見つかりませんでした。'))
                      })
                    }
                  >
                    {generating ? t('AI が考えています…') : hasBlock(lesson.data.body, 'sim') ? t('動く図解を選び直す') : t('AI に動く図解を足してもらう')}
                  </button>
                )}
              </footer>
              {SOURCE && video.data && (
                <p className="textbook-video">
                  <button className="btn" onClick={() => void api.view.open('video', { lessonId, variant: shown })}>{t('この授業を動画で見る（試作）')}</button>
                </p>
              )}
              {SOURCE && annotation.data === null && lesson.data.status !== 'none' && (
                <p className="textbook-annot">
                  <button className="btn btn-quiet" disabled={generating} title={t('この授業の用語の解説・ふりがな・関連する授業を、AI に用意してもらいます')} onClick={() => void run(() => api.annot.make(lessonId, shown).then(() => annotation.reload()))}>
                    {generating ? t('AI が用意しています…（30 秒ほどかかります）') : t('AI に、用語の解説とふりがなを用意してもらう')}
                  </button>
                </p>
              )}
              {info && <p className="muted">{info}</p>}
              {error && <p className="form-error">{error}</p>}
            </div>
          ) : meta && lesson.data === null ? (
            <div className="paper paper-empty">
              <h2>
                {meta.number} {meta.title}
              </h2>
              <p>{tx('この授業の教科書{0}は、まだ用意されていません。', shown === 'deep' ? t('（学び直し向け）') : '')}</p>
              <p className="muted">{tx('扱う内容: {0}', meta.summary)}</p>
              {SOURCE ? (
                <button className="btn btn-primary" disabled={generating} onClick={() => void run(() => api.content.generate(lessonId, shown))}>
                  {generating ? t('AI が教科書を書いています…（1 分ほどかかります）') : t('AI に教科書を作ってもらう')}
                </button>
              ) : (
                <SOURCE_ONLY />
              )}
              {error && <p className="form-error">{error}</p>}
            </div>
          ) : null}
        </article>
      </div>

      {termCard && termInfo && (
        <aside className="term-card" role="dialog" aria-label={t('用語の解説')} style={{ left: termCard.x, top: termCard.y }}>
          <header>
            <strong>{termInfo.term}</strong>
            <small>{termInfo.reading}</small>
            <button className="btn btn-quiet" aria-label={t('閉じる')} onClick={() => setTermCard(null)}>×</button>
          </header>
          <p>{termInfo.short}</p>
          <button className="btn btn-mode" data-mode="textbook" onClick={() => void api.view.open('glossary', { term: termInfo.term }).then(() => setTermCard(null))}>{t('用語集を開く')}</button>
        </aside>
      )}

      {selection && (
        <button
          className="selection-ask"
          style={{ left: selection.x, top: selection.y }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            void api.view.open('chat', { lessonId, quote: selection.text })
            window.getSelection()?.removeAllRanges()
            setSelection(null)
          }}
        >{t('この部分を質問する')}</button>
      )}
    </div>
  )
}
