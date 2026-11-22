import type { NotePage } from '@shared/types'
import { needsTranscript } from '../lib/transcribe'
import { t, tx } from '@/lib/i18n'

/**
 * 手書きの文字起こし（評価はしない）。
 * 起こした文字は、タイピングした文字と同じように、検索・コピー・書き直しができ、ページに入れることもできる。
 */
export function TranscriptPanel({
  pages,
  inkPages,
  busy,
  error,
  onRun,
  onEdit,
  onInsert,
}: {
  /** 開いている見開きのページ（番号は 0 始まり） */
  pages: { index: number; page: NotePage }[]
  /** ノート全体で、手書きのあるページの数 */
  inkPages: number
  /** 文字起こしの途中経過（していないときは null） */
  busy: { done: number; total: number } | null
  error: string | null
  /** spread: 開いているページ / all: ノート全体 */
  onRun: (scope: 'spread' | 'all') => void
  onEdit: (index: number, text: string) => void
  /** 文字起こしを、タイピングの文字としてページに入れる。replace が真なら、手書きを消して置きかえる */
  onInsert: (index: number, replace: boolean) => void
}) {
  return (
    <div className="transcript">
      <p className="muted">{t('手書きの文字を、AI が文字に起こします（評価はしません）。起こした文字は、タイピングした文字と同じように、検索・コピー・書き直しができます。')}</p>
      {busy ? (
        <p className="transcript-busy" role="status">
          <strong>{tx('文字に起こしています…（{0} / {1} ページ）', busy.done, busy.total)}</strong>
          <span className="muted">{t('1 ページにつき 10〜30 秒ほどかかります。このまま続きを書いていても大丈夫です。')}</span>
        </p>
      ) : (
        <div className="transcript-actions">
          <button className="btn btn-primary btn-wide" disabled={!pages.some(({ page }) => page.strokes.length)} onClick={() => onRun('spread')}>{t('開いているページを文字起こしする')}</button>
          <button className="btn btn-wide" disabled={!inkPages} onClick={() => onRun('all')}>{tx('このノート全体（手書きのある {0} ページ）', inkPages)}</button>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}

      {pages.map(({ index, page }) => {
        const has = page.transcript !== undefined && page.transcriptStamp !== undefined
        const stale = has && needsTranscript(page)
        return (
          <section key={page.id} className="transcript-page">
            <header>
              <strong>p.{index + 1}</strong>
              <span className="chip" data-state={!page.strokes.length ? 'none' : !has ? 'todo' : stale ? 'stale' : 'done'}>
                {!page.strokes.length ? t('手書きなし') : !has ? t('まだ起こしていません') : stale ? t('書き足し・消したあとは、まだです') : t('文字起こし済み')}
              </span>
            </header>
            {has && (
              <>
                <textarea
                  value={page.transcript ?? ''}
                  rows={Math.min(14, Math.max(3, (page.transcript ?? '').split('\n').length + 1))}
                  spellCheck={false}
                  aria-label={t('p.{0} の文字起こし（書き直せます）', index + 1)}
                  placeholder={t('（読み取れる文字は、ありませんでした）')}
                  onChange={(e) => onEdit(index, e.target.value)}
                />
                <div className="transcript-page-actions">
                  <button className="btn" disabled={!page.transcript?.trim()} onClick={() => void navigator.clipboard?.writeText(page.transcript ?? '')}>{t('コピー')}</button>
                  <button className="btn" disabled={!page.transcript?.trim()} title={t('文字起こしを、タイピングの文字としてページに入れます（手書きは残ります）')} onClick={() => onInsert(index, false)}>{t('ページに入れる')}</button>
                  <button className="btn" disabled={!page.transcript?.trim() || stale} title={t('手書きの線を消して、文字起こしをタイピングの文字として入れます（Ctrl + Z で元に戻せます）')} onClick={() => onInsert(index, true)}>{t('手書きを文字に置きかえる')}</button>
                </div>
              </>
            )}
          </section>
        )
      })}
      <p className="muted">{t('AI の読みまちがいは、上の欄で直せます。図や絵は【図: …】と書かれます。')}</p>
    </div>
  )
}
