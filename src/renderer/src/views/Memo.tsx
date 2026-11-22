import { useRef, useState } from 'react'
import type { NotebookSummary } from '@shared/types'
import { PinButton } from '../components/PinButton'
import { api, errorMessage, useLoad } from '../lib/hooks'
import { needsTranscript, transcribePages, TRANSCRIBE_BATCH } from '../lib/transcribe'
import { LOCALE, t, tx } from '@/lib/i18n'

const formatDate = (at: number) => new Date(at).toLocaleString(LOCALE, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
/** 授業の ID（<科目>-<単元>-<授業>）から、科目の ID を取り出す */
const courseOf = (lessonId: string) => lessonId.replace(/-\d+-\d+$/, '')

interface Progress {
  /** いま文字起こししているノートの題名 */
  title: string
  done: number
  total: number
}

/**
 * メモモード。授業と関係なく使えるノート（メモ）を、名前を付けていくつでも作り、開く。
 * メモは、先生の評価が無いこと以外は、ノートと同じ（手書き・タイピング・図形・文字起こし・PDF）。
 * この画面からは、すべてのメモとノートの手書きを、まとめて文字起こしすることもできる。
 */
export function Memo() {
  const notebooks = useLoad(() => api.notes.list(), [], ['notes'])
  const courses = useLoad(() => api.content.courses(), [], ['content'])
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [redo, setRedo] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [report, setReport] = useState<{ text: string; ok: boolean } | null>(null)
  const stop = useRef(false)

  const memos = (notebooks.data ?? []).filter((n) => n.kind === 'memo')
  const lessons = (notebooks.data ?? []).filter((n) => n.kind === 'lesson')
  const all = [...memos, ...lessons]
  const inkPages = all.reduce((sum, n) => sum + n.inkPages, 0)
  const todoPages = all.reduce((sum, n) => sum + (n.inkPages - n.transcribedPages), 0)
  const target = redo ? inkPages : todoPages

  const create = async () => {
    setError(null)
    try {
      const made = await api.notes.createMemo(title)
      setTitle('')
      await api.view.open('note', { notebookId: made.id })
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const remove = async (memo: NotebookSummary) => {
    if (!window.confirm(t('メモ「{0}」を消します。もとにはもどせません。消しますか？', memo.title))) return
    setError(null)
    try {
      await api.notes.deleteMemo(memo.id)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  /** すべてのメモとノートの手書きを、まとめて文字起こしする */
  const transcribeAll = async () => {
    if (progress) return
    stop.current = false
    setReport(null)
    let done = 0
    try {
      const list = (await api.notes.list()).filter((n) => (n.kind === 'memo' || n.kind === 'lesson') && (redo ? n.inkPages > 0 : n.inkPages > n.transcribedPages))
      const total = list.reduce((sum, n) => sum + (redo ? n.inkPages : n.inkPages - n.transcribedPages), 0)
      if (!total) return setReport({ text: t('文字起こしするページは、ありません。'), ok: true })
      for (const summary of list) {
        if (stop.current) break
        const notebook = await api.notes.get(summary.id)
        if (!notebook) continue
        const indexes = notebook.pages.map((_, i) => i).filter((i) => (redo ? notebook.pages[i].strokes.length > 0 : needsTranscript(notebook.pages[i])))
        // 1 回ぶん（数ページ）が終わるたびに保存する（途中で止めても、終わったぶんは残る）
        for (let at = 0; at < indexes.length && !stop.current; at += TRANSCRIBE_BATCH) {
          setProgress({ title: notebook.title, done, total })
          const results = await transcribePages(notebook, indexes.slice(at, at + TRANSCRIBE_BATCH))
          await api.notes.saveTranscripts(notebook.id, results.map(({ pageId, stamp, text }) => ({ pageId, stamp, text })))
          done += results.length
        }
      }
      setReport({ text: stop.current ? t('止めました。{0} ページを文字起こししました。', done) : t('{0} ページを文字起こししました。', done), ok: true })
    } catch (e) {
      setReport({ text: t('{0} ページまで終わったところで、止まりました: {1}', done, errorMessage(e)), ok: false })
    } finally {
      setProgress(null)
      notebooks.reload()
    }
  }

  const row = (n: NotebookSummary, sub: string) => (
    <li key={n.id} className="memo-row">
      <button className="memo-open" onClick={() => void api.view.open('note', { notebookId: n.id })}>
        <strong>{n.title || t('無題')}</strong>
        <small>
          {sub ? `${sub} ／ ` : ''}
          {tx('{0} ページ ／ {1}', n.pageCount, formatDate(n.updatedAt))}
          {n.inkPages > 0 && <>{tx(' ／ 手書き {0} ページ（文字起こし済み {1}）', n.inkPages, n.transcribedPages)}</>}
        </small>
      </button>
      <button className="btn btn-mode" data-mode="note" onClick={() => void api.view.open('note', { notebookId: n.id })}>{t('開く')}</button>
      {n.kind === 'memo' && <button className="btn btn-quiet" onClick={() => void remove(n)}>{t('消す')}</button>}
    </li>
  )

  return (
    <div className="memo">
      <header className="view-header" data-mode="note">
        <div className="view-header-title">
          <small>{t('授業と関係なく使えるノート')}</small>
          <strong>{t('メモ')}</strong>
        </div>
        <div className="view-header-actions">
          <PinButton className="btn btn-quiet" />
        </div>
      </header>

      <div className="memo-body">
        <section className="card">
          <h2 className="section-title">{t('新しいメモ')}</h2>
          <form
            className="memo-new"
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
          >
            <input type="text" value={title} maxLength={60} placeholder={t('メモの名前（例: 読書メモ、買い物リスト）')} aria-label={t('メモの名前')} onChange={(e) => setTitle(e.target.value)} />
            <button className="btn btn-primary" type="submit">{t('メモを作って開く')}</button>
          </form>
          <p className="muted">{t('メモは、先生の評価が無いこと以外は、ノートと同じように使えます（手書き・タイピング・図形や表・文字起こし・PDF）。名前は、開いたメモの左上で、あとから変えられます。')}</p>
          {error && <p className="form-error">{error}</p>}
        </section>

        <section className="card">
          <h2 className="section-title">{tx('メモ（{0}）', memos.length)}</h2>
          {memos.length ? <ul className="memo-list">{memos.map((n) => row(n, ''))}</ul> : <p className="muted">{t('まだ、メモはありません。上の欄に名前を入れて、作ってみましょう。')}</p>}
        </section>

        <section className="card">
          <h2 className="section-title">{tx('授業のノート（{0}）', lessons.length)}</h2>
          {lessons.length ? (
            <ul className="memo-list">{lessons.map((n) => row(n, courses.data?.find((c) => c.id === courseOf(n.lessonId ?? ''))?.title ?? ''))}</ul>
          ) : (
            <p className="muted">{t('授業のノートは、ホームや教科書の「ノート」から開くと、ここに並びます。')}</p>
          )}
        </section>

        <section className="card">
          <h2 className="section-title">{t('手書きを、まとめて文字起こしする')}</h2>
          <p className="muted">
            {tx('すべてのメモとノートの手書きを、AI が文字に起こします（評価はしません）。手書きのあるページは {0} ページ、そのうち、まだ文字起こししていないのは {1} ページです。', inkPages, todoPages)}
          </p>
          <label className="check">
            <input type="checkbox" checked={redo} disabled={!!progress} onChange={(e) => setRedo(e.target.checked)} />
            {t('文字起こし済みのページも、やり直す')}
          </label>
          {progress ? (
            <div className="memo-progress" role="status">
              <strong>{tx('文字に起こしています…（{0} / {1} ページ）', progress.done, progress.total)}</strong>
              <span className="muted">{tx('いまのノート: {0}', progress.title)}</span>
              <div className="meter meter-wide"><i style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} /></div>
              <button className="btn" onClick={() => (stop.current = true)}>{t('止める（いまのページが終わったら止まります）')}</button>
            </div>
          ) : (
            <button className="btn btn-primary" disabled={!target} onClick={() => void transcribeAll()}>{tx('{0} ページを文字起こしする', target)}</button>
          )}
          {report && <p className={report.ok ? 'memo-report' : 'form-error'}>{report.text}</p>}
          <p className="muted">{t('1 ページにつき 10〜30 秒ほどかかり、AI の使用量を使います。この画面を開いているあいだだけ進みます。起こした文字は、それぞれのノートの「文字起こし」で、見たり直したりできます。')}</p>
        </section>
      </div>
    </div>
  )
}
