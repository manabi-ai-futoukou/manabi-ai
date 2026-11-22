import { useState } from 'react'
import { KANJI_SCOPE_LABEL, KANJI_TIMES, formatKun, groupsInScope } from '@shared/kanji'
import type { KanjiScope, KanjiSetup, KanjiState } from '@shared/types'
import { api, errorMessage, useLoad } from '../lib/hooks'
import { t, tx } from '@/lib/i18n'

/** 同梱している漢字データの出どころ（ライセンスの条件として、画面に表示する） */
export function KanjiCredit() {
  return (
    <p className="kanji-credit">{t('書き順: KanjiVG（© Ulrich Apel、CC BY-SA 3.0）／ 読み・学年: KANJIDIC2（© EDRDG、CC BY-SA 4.0）')}</p>
  )
}

/**
 * 漢字特訓モード（1 つ目のウィンドウ）。漢字と読み、代表的な単語、例文を表示する。
 * 書き順のアニメーションと、書きこむノートは、別のウィンドウに開く。
 */
export function Kanji() {
  const state = useLoad(() => api.kanji.state(), [], ['kanji'])
  if (!state.data) return null
  return state.data.active ? <Card state={state.data} /> : <Setup state={state.data} />
}

// ───────── 準備 ─────────

function Setup({ state }: { state: KanjiState }) {
  const [setup, setSetup] = useState<KanjiSetup>(state.setup)
  const [error, setError] = useState<string | null>(null)
  const count = useLoad(() => api.kanji.count(setup), [JSON.stringify(setup)], ['kanji'])
  const groups = groupsInScope(setup.scope)

  const toggleGroup = (id: string) => setSetup((s) => ({ ...s, groups: s.groups.includes(id) ? s.groups.filter((g) => g !== id) : [...s.groups, id] }))
  const start = async () => {
    setError(null)
    try {
      await api.kanji.start(setup)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div className="test">
      <header className="view-header" data-mode="kanji">
        <div className="view-header-title">
          <small>{t('漢字特訓')}</small>
          <strong>{t('特訓の準備')}</strong>
        </div>
      </header>
      <div className="test-scroll">
        <div className="paper test-setup">
          <div className="field">
            <span>{t('出す順番')}</span>
            <div className="segmented">
              <button aria-pressed={setup.order === 'learn'} onClick={() => setSetup({ ...setup, order: 'learn' })}>{t('習う順')}</button>
              <button aria-pressed={setup.order === 'random'} onClick={() => setSetup({ ...setup, order: 'random' })}>{t('ランダム')}</button>
            </div>
          </div>

          <div className="field">
            <span>{t('対象')}</span>
            <div className="segmented">
              {(Object.keys(KANJI_SCOPE_LABEL) as KanjiScope[]).map((scope) => (
                <button key={scope} aria-pressed={setup.scope === scope} onClick={() => setSetup({ ...setup, scope, groups: [] })}>
                  {KANJI_SCOPE_LABEL[scope]}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>{t('範囲（選ばなければ、対象のすべて）')}</span>
            <div className="chips">
              {groups.map((g) => (
                <button key={g.id} className="chip-toggle" aria-pressed={setup.groups.includes(g.id)} onClick={() => toggleGroup(g.id)}>
                  {g.label}
                </button>
              ))}
            </div>
            <small>{tx('この条件の漢字: {0}', count.data ? t('{0} 字（クリア済み {1} 字）', count.data.total.toLocaleString(), count.data.done.toLocaleString()) : '—')}
            </small>
          </div>

          <p className="notice">{tx('3 つのウィンドウが開きます。「漢字」には読み・単語・例文が、「書き順」には書き順のアニメーションが出ます。「ノート」のマスに、正しい書き順で {0} 回書き、単語と例文を書き写すと、次の漢字へ進みます。1 字クリアするたびに「漢字力」が上がります。', KANJI_TIMES)}</p>
          {error && <p className="form-error">{error}</p>}
          <button className="btn btn-primary btn-wide" disabled={!count.data?.total} onClick={() => void start()}>{t('特訓を始める')}</button>
          <KanjiCredit />
        </div>
      </div>
    </div>
  )
}

// ───────── 特訓中 ─────────

function Card({ state }: { state: KanjiState }) {
  const skills = useLoad(() => api.skills.get(), [], ['skills'])
  const [error, setError] = useState<string | null>(null)
  const entry = state.entry
  const skill = skills.data?.values.kanji ?? 0

  const run = async (action: () => Promise<unknown>) => {
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div className="drill">
      <header className="view-header" data-mode="kanji">
        <div className="view-header-title">
          <small>{tx('漢字特訓 ／ {0}・{1}', state.setup.order === 'learn' ? t('習う順') : t('ランダム'), KANJI_SCOPE_LABEL[state.setup.scope])}
          </small>
          <strong>{tx('この範囲 {0} / {1} 字', state.pool.done.toLocaleString(), state.pool.total.toLocaleString())}</strong>
        </div>
        <div className="view-header-actions">
          <button className="btn btn-mode" data-mode="kanji" onClick={() => void api.view.open('kanjiOrder')}>{t('書き順')}</button>
          <button className="btn btn-mode" data-mode="note" onClick={() => void api.view.open('kanjiNote')}>{t('ノート')}</button>
          <button className="btn" disabled={!entry} onClick={() => void run(() => api.kanji.skip())}>{t('とばす')}</button>
          <button className="btn" onClick={() => void run(() => api.kanji.stop())}>{t('やめる')}</button>
        </div>
      </header>

      <div className="kanji-card-scroll">
        {entry && (
          <main className="drill-card kanji-card">
            <div className="kanji-head">
              <h1 className="kanji-char" lang="ja">
                {entry.char}
              </h1>
              <dl className="kanji-facts">
                <div>
                  <dt>{t('習う時期')}</dt>
                  <dd>{entry.gradeLabel}</dd>
                </div>
                <div>
                  <dt>{t('画数')}</dt>
                  <dd>{tx('{0} 画', entry.strokes.length)}</dd>
                </div>
                <div>
                  <dt>{t('音読み')}</dt>
                  <dd>{entry.on.join('、') || '—'}</dd>
                </div>
                <div>
                  <dt>{t('訓読み')}</dt>
                  <dd>{entry.kun.map(formatKun).join('、') || '—'}</dd>
                </div>
              </dl>
            </div>

            <p className="kanji-step" data-done={state.written >= KANJI_TIMES}>{tx('ノートのマスに、正しい書き順で {0} 回書く{1}', KANJI_TIMES, <b>
                {Math.min(state.written, KANJI_TIMES)} / {KANJI_TIMES}
              </b>)}
            </p>

            {state.words ? (
              <>
                {!!state.words.words.length && (
                  <div>
                    <h3>{t('この漢字を使う言葉')}</h3>
                    <ul className="kanji-words">
                      {state.words.words.map((w) => (
                        <li key={w.word}>
                          <strong lang="ja">{w.word}</strong>
                          <span>{w.reading}</span>
                          <small>{w.meaning}</small>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {!!state.words.sentences.length && (
                  <div>
                    <h3>{t('例文')}</h3>
                    <ul className="drill-examples kanji-sentences">
                      {state.words.sentences.map((s) => (
                        <li key={s} lang="ja">
                          {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {state.words.words.length + state.words.sentences.length > 0 ? (
                  <p className="muted">{tx('{0} 回書けたら、上の言葉と例文を、ノートの右のページに書き写しましょう。', KANJI_TIMES)}</p>
                ) : (
                  <p className="muted">{tx('この漢字には、書き写す言葉と例文がありません。{0} 回書けたら、次へ進めます。', KANJI_TIMES)}</p>
                )}
              </>
            ) : state.wordsError ? (
              <div className="drill-empty">
                <p className="form-error">{tx('言葉と例文を用意できませんでした。{0}', state.wordsError)}</p>
                <button className="btn" onClick={() => void run(() => api.kanji.retryWords())}>{t('もう一度用意する')}</button>
                <p className="muted">{tx('用意できなくても、{0} 回書けば次へ進めます。', KANJI_TIMES)}</p>
              </div>
            ) : (
              <p className="arena-waiting">
                {tx('{0}言葉と例文を用意しています…（書く練習は、先に始められます）', <span className="typing" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>)}</p>
            )}
            {error && <p className="form-error">{error}</p>}

            <ul className="meter-list">
              <li>
                <span className="meter-name">
                  <strong>{t('漢字力')}</strong>
                  <small>{tx('クリア {0} 字', state.cleared.toLocaleString())}</small>
                </span>
                <span className="meter-track" role="img" aria-label={t('漢字力 {0} 点', skill.toFixed(1))}>
                  <i style={{ width: `${skill}%` }} />
                </span>
                <span className="meter-figure">
                  {skill.toFixed(1)}
                  <small>{t('点')}</small>
                </span>
              </li>
            </ul>
            <KanjiCredit />
          </main>
        )}
      </div>
    </div>
  )
}
