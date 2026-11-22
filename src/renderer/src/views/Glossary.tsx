import { useEffect, useState } from 'react'
import { SCHOOLS, type GlossaryItem, type ViewParams } from '@shared/types'
import { PinButton } from '../components/PinButton'
import { api, useLoad } from '../lib/hooks'
import { getLang, t, tx } from '@/lib/i18n'

const ROWS = ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ']
const PAGE = 120
const schoolLabel = (id: string) => SCHOOLS.find(([school]) => school === id)?.[1] ?? id

/**
 * 用語集モード。あらゆる科目の用語を、読みの順に並べ、言葉・学校・教科でしぼりこめる。
 * 用語を選ぶと、くわしい解説と、その用語を学ぶ学年・授業（対象の範囲）が見られる。
 * 用語のデータは、授業ごとの注釈（AI が授業の本文から作ったもの）をまとめたもの。
 */
export function Glossary({ params }: { params: ViewParams }) {
  const courses = useLoad(() => api.content.courses(), [], ['content'])
  const [query, setQuery] = useState(params.term ?? '')
  const [asked, setAsked] = useState(params.term ?? '')
  const [school, setSchool] = useState('')
  const [subject, setSubject] = useState('')
  const [initial, setInitial] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [selected, setSelected] = useState<string | null>(params.term ?? null)
  const list = useLoad(() => api.annot.glossary({ query: asked, school, subject, initial, limit }), [asked, school, subject, initial, limit], ['annot'])
  const entry = useLoad(() => (selected ? api.annot.term(selected) : Promise.resolve(null)), [selected], ['annot'])

  // ほかの画面（教科書の「用語集を開く」）から、用語を指定して開かれたとき
  useEffect(() => {
    if (!params.term) return
    setQuery(params.term)
    setAsked(params.term)
    setSchool('')
    setSubject('')
    setInitial('')
    setSelected(params.term)
  }, [params.term])

  // 入力が止まってから探す
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAsked(query)
      setLimit(PAGE)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query])

  const subjects = [...new Map((courses.data ?? []).filter((c) => !school || c.school === school).map((c) => [c.subject, c.subjectLabel])).entries()]
  const pick = (change: () => void) => {
    change()
    setLimit(PAGE)
  }

  if (getLang() !== 'ja') return <p className="view-error">{t('用語集は、日本語で表示しているときに使えます。')}</p>

  return (
    <div className="glossary" data-detail={selected ? 'open' : undefined}>
      <header className="view-header" data-mode="textbook">
        <div className="view-header-title">
          <small>{t('あらゆる科目の用語')}</small>
          <strong>{t('用語集')}</strong>
        </div>
        <div className="view-header-actions">
          <button className="btn btn-quiet" onClick={() => void api.view.open('search', { query })}>{t('教科書やノートも探す')}</button>
          <PinButton className="btn btn-quiet" />
        </div>
      </header>

      <div className="glossary-body">
        <nav className="glossary-list" aria-label={t('用語の一覧')}>
          <input type="search" value={query} placeholder={t('用語や読みで探す（例: こうごうせい、関数）')} aria-label={t('用語を探す')} onChange={(e) => setQuery(e.target.value)} />
          <div className="glossary-filters">
            <select value={school} aria-label={t('学校')} onChange={(e) => pick(() => (setSchool(e.target.value), setSubject('')))}>
              <option value="">{t('すべての学校')}</option>
              {SCHOOLS.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
            <select value={subject} aria-label={t('教科')} onChange={(e) => pick(() => setSubject(e.target.value))}>
              <option value="">{t('すべての教科')}</option>
              {subjects.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </div>
          <div className="chips glossary-rows" role="group" aria-label={t('読みのはじめの行')}>
            <button className="chip-toggle" aria-pressed={!initial} onClick={() => pick(() => setInitial(''))}>{t('全部')}</button>
            {ROWS.map((row) => (
              <button key={row} className="chip-toggle" aria-pressed={initial === row} onClick={() => pick(() => setInitial(initial === row ? '' : row))}>{row}</button>
            ))}
          </div>
          {list.data && !list.data.ready ? (
            <p className="muted">{t('用語集のデータが、まだありません。教科書で授業を開いて「AI に、用語の解説とふりがなを用意してもらう」を押すか、まとめて作る道具（tools/annotate-lessons.mjs と tools/build-glossary.mjs）を動かすと、ここに並びます。')}</p>
          ) : (
            <>
              <p className="muted glossary-count">{tx('{0} 語', (list.data?.total ?? 0).toLocaleString())}</p>
              <ul>
                {(list.data?.items ?? []).map((item: GlossaryItem) => (
                  <li key={item.term}>
                    <button className="glossary-item" aria-current={selected === item.term} onClick={() => setSelected(item.term)}>
                      <strong>{item.term}</strong>
                      <small>{item.reading}</small>
                      <span>{item.short}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {list.data && list.data.total > list.data.items.length && (
                <button className="btn btn-wide" onClick={() => setLimit(limit + PAGE)}>{tx('もっと見る（あと {0} 語）', (list.data.total - list.data.items.length).toLocaleString())}</button>
              )}
            </>
          )}
        </nav>

        <main className="glossary-detail">
          {!selected ? (
            <p className="muted glossary-empty">{t('左の一覧から用語を選ぶと、くわしい解説と、その用語を学ぶ学年・授業が見られます。')}</p>
          ) : !entry.data ? (
            <p className="muted glossary-empty">{entry.data === null ? t('この用語は、用語集に見つかりませんでした。') : t('読みこんでいます…')}</p>
          ) : (
            <article className="paper glossary-paper">
              <button className="btn btn-quiet glossary-back" onClick={() => setSelected(null)}>{t('‹ 一覧にもどる')}</button>
              <header className="glossary-head">
                <p className="glossary-reading">{entry.data.reading}</p>
                <h1>{entry.data.term}</h1>
                {entry.data.aliases.length > 0 && <p className="muted">{tx('別の書き方: {0}', entry.data.aliases.join(t('、')))}</p>}
                <p className="glossary-scope">
                  <span>{t('学ぶ学年・範囲')}</span>
                  {[...new Set(entry.data.uses.map((use) => use.courseTitle))].map((title) => (
                    <b key={title} className="chip">{title}</b>
                  ))}
                  {entry.data.total > entry.data.uses.length && <small>{tx('ほか（全 {0} 授業）', entry.data.total)}</small>}
                </p>
              </header>
              {entry.data.uses.map((use) => (
                <section key={`${use.lessonId}:${use.variant}`} className="glossary-use">
                  <header>
                    <span className="chip" data-school={use.school}>{schoolLabel(use.school)}</span>
                    <strong>{use.courseTitle} ／ {use.number} {use.title}</strong>
                    <button className="btn btn-mode" data-mode="textbook" onClick={() => void api.view.open('textbook', { lessonId: use.lessonId, variant: use.variant })}>{t('教科書で開く')}</button>
                  </header>
                  <p className="glossary-short">{use.short}</p>
                  <p>{use.detail}</p>
                </section>
              ))}
              <p className="notice">{t('用語の解説は、AI が授業の本文をもとに作りました。人の目による確認は、まだ行われていません。')}</p>
            </article>
          )}
        </main>
      </div>
    </div>
  )
}
