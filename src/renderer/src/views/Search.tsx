import { useEffect, useRef, useState, type ReactNode } from 'react'
import { HIT_CLOSE, HIT_OPEN } from '@shared/search'
import { SCHOOLS, type SearchHit, type SearchResult, type SearchSource, type ViewParams } from '@shared/types'
import { PinButton } from '../components/PinButton'
import { api, errorMessage, useLoad } from '../lib/hooks'
import { getLang, t, tx } from '@/lib/i18n'

const SOURCES: { id: SearchSource; label: string; hint: string }[] = [
  { id: 'textbook', label: t('教科書'), hint: t('授業の本文') },
  { id: 'note', label: t('ノート'), hint: t('授業のノート（入力した文字と、文字起こしした手書き）') },
  { id: 'memo', label: t('メモ'), hint: t('メモ（入力した文字と、文字起こしした手書き）') },
  { id: 'glossary', label: t('用語集'), hint: t('用語・読み・解説') },
]
const GROUP_ORDER: SearchSource[] = ['glossary', 'memo', 'note', 'textbook']

/** 切り出した文の中の、見つけた言葉に色を付ける */
function Snippet({ text }: { text: string }) {
  const parts: ReactNode[] = []
  text.split(HIT_OPEN).forEach((part, i) => {
    if (i === 0) return parts.push(part)
    const [hit, rest = ''] = part.split(HIT_CLOSE)
    parts.push(<mark key={i}>{hit}</mark>, rest)
  })
  return <p className="search-snippet">{parts}</p>
}

/**
 * 検索モード。教科書・ノート・メモ・用語集から、言葉を探す。
 * 探す範囲（どれを探すか、教科書はどの学校・どの科目を探すか）は、自由に選べる。
 */
export function Search({ params }: { params: ViewParams }) {
  const courses = useLoad(() => api.content.courses(), [], ['content'])
  const [query, setQuery] = useState(params.query ?? '')
  const [sources, setSources] = useState<SearchSource[]>(['textbook', 'note', 'memo', 'glossary'])
  const [schools, setSchools] = useState<string[]>([])
  const [courseId, setCourseId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ query: string; data: SearchResult } | null>(null)
  const serial = useRef(0)

  const run = async (text = query) => {
    const word = text.trim()
    if (!word || !sources.length) return
    const mine = ++serial.current
    setBusy(true)
    setError(null)
    try {
      const data = await api.annot.search({ query: word, sources, schools, courseId: courseId || undefined })
      if (mine === serial.current) setResult({ query: word, data })
    } catch (e) {
      if (mine === serial.current) setError(errorMessage(e))
    } finally {
      if (mine === serial.current) setBusy(false)
    }
  }

  // ほかの画面から、言葉を指定して開かれたとき
  useEffect(() => {
    if (!params.query) return
    setQuery(params.query)
    void run(params.query)
  }, [params.query])

  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value])
  const open = (hit: SearchHit) => {
    if (hit.source === 'textbook' && hit.lessonId) void api.view.open('textbook', { lessonId: hit.lessonId, variant: hit.variant })
    else if (hit.source === 'glossary' && hit.term) void api.view.open('glossary', { term: hit.term })
    else if (hit.notebookId) void api.view.open('note', { notebookId: hit.notebookId, page: hit.page })
  }
  const coursesShown = (courses.data ?? []).filter((c) => c.ready > 0 && (!schools.length || schools.includes(c.school)))

  return (
    <div className="search-view">
      <header className="view-header" data-mode="textbook">
        <div className="view-header-title">
          <small>{t('教科書・ノート・メモ・用語集から探す')}</small>
          <strong>{t('検索')}</strong>
        </div>
        <div className="view-header-actions">
          <PinButton className="btn btn-quiet" />
        </div>
      </header>

      <div className="search-body">
        <section className="card search-form">
          <form
            className="search-row"
            onSubmit={(e) => {
              e.preventDefault()
              void run()
            }}
          >
            <input autoFocus type="search" value={query} maxLength={60} placeholder={t('探したい言葉（例: 光合成、関ヶ原、比例）')} aria-label={t('探したい言葉')} onChange={(e) => setQuery(e.target.value)} />
            <button className="btn btn-primary" type="submit" disabled={busy || !query.trim() || !sources.length}>{busy ? t('探しています…') : t('探す')}</button>
          </form>

          <div className="search-scope">
            <strong>{t('探す範囲')}</strong>
            <div className="chips">
              {SOURCES.filter((s) => s.id !== 'glossary' || getLang() === 'ja').map((s) => (
                <button key={s.id} className="chip-toggle" aria-pressed={sources.includes(s.id)} title={s.hint} onClick={() => setSources(toggle(sources, s.id))}>{s.label}</button>
              ))}
              <button className="btn btn-quiet" onClick={() => setSources(sources.length === SOURCES.length ? [] : SOURCES.map((s) => s.id))}>{sources.length === SOURCES.length ? t('すべて外す') : t('すべて選ぶ')}</button>
            </div>
          </div>
          {sources.includes('textbook') && (
            <div className="search-scope">
              <strong>{t('教科書の範囲')}</strong>
              <div className="chips">
                <button className="chip-toggle" aria-pressed={!schools.length && !courseId} onClick={() => (setSchools([]), setCourseId(''))}>{t('すべての学校')}</button>
                {SCHOOLS.map(([id, label]) => (
                  <button key={id} className="chip-toggle" aria-pressed={schools.includes(id)} onClick={() => (setSchools(toggle(schools, id)), setCourseId(''))}>{label}</button>
                ))}
              </div>
              <select value={courseId} aria-label={t('科目')} onChange={(e) => setCourseId(e.target.value)}>
                <option value="">{t('（選んだ学校の）すべての科目')}</option>
                {coursesShown.map((c) => (
                  <option key={c.id} value={c.id}>{c.title}</option>
                ))}
              </select>
            </div>
          )}
          {!sources.length && <p className="form-error">{t('探す範囲を、1 つ以上選んでください。')}</p>}
          {error && <p className="form-error">{error}</p>}
        </section>

        {result && !busy && (
          <section className="search-results" aria-live="polite">
            {result.data.hits.length === 0 && <p className="card muted">{tx('「{0}」は、選んだ範囲には見つかりませんでした。言葉を短くするか、範囲を広げてみてください。', result.query)}</p>}
            {GROUP_ORDER.map((source) => {
              const hits = result.data.hits.filter((hit) => hit.source === source)
              if (!hits.length) return null
              const total = result.data.totals[source] ?? hits.length
              return (
                <div key={source} className="card search-group">
                  <h2 className="section-title">
                    {SOURCES.find((s) => s.id === source)?.label}
                    <small>{total > hits.length ? tx('{0} 件のうち、はじめの {1} 件', total.toLocaleString(), hits.length) : tx('{0} 件', hits.length)}</small>
                  </h2>
                  <ul>
                    {hits.map((hit, i) => (
                      <li key={i}>
                        <button className="search-hit" onClick={() => open(hit)}>
                          <span className="search-hit-head">
                            <strong>{hit.title}</strong>
                            <small>{hit.where}</small>
                            {hit.count > 1 && source !== 'glossary' && <em>{tx('{0} か所', hit.count)}</em>}
                          </span>
                          {hit.snippets.map((snippet, n) => (
                            <Snippet key={n} text={snippet} />
                          ))}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </section>
        )}
        {!result && !busy && <p className="muted search-hint">{t('手書きの文字は、ノートやメモの「文字起こし」をすると、ここで探せるようになります（メモの画面から、まとめて文字起こしできます）。')}</p>}
      </div>
    </div>
  )
}
