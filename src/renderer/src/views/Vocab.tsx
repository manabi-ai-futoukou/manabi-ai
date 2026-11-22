import { useState } from 'react'
import type { VocabLang, VocabState } from '@shared/types'
import { VOCAB_LANG_LABEL, VOCAB_LEVELS, VOCAB_SENTENCES, VOCAB_WORD_TIMES, findVocabLevel } from '@shared/vocab'
import { SpeakButton } from '../components/SpeakButton'
import { api, errorMessage, useLoad } from '../lib/hooks'
import { t, tx } from '@/lib/i18n'

const SKILL_LABEL: Record<VocabLang, string> = { ja: t('語彙力（日本語）'), en: t('語彙力（英語）') }

/**
 * 語彙力特訓モード（1 つ目のウィンドウ）。単語・意味・例文を表示する。
 * 書くのは、もう 1 つのウィンドウ（練習用のノート）。ノートの「書けた！」を押すと、AI が確かめる。
 */
export function Vocab() {
  const state = useLoad(() => api.vocab.state(), [], ['vocab'])
  if (!state.data) return null
  return state.data.active ? <Drill state={state.data} /> : <Setup state={state.data} />
}

// ───────── 準備 ─────────

function Setup({ state }: { state: VocabState }) {
  const [lang, setLang] = useState<VocabLang>(state.lang)
  const [levelId, setLevelId] = useState(state.levelId)
  const [error, setError] = useState<string | null>(null)
  const copy = state.sentenceMode === 'copy'
  const levels = VOCAB_LEVELS[lang]
  const level = levels.find((l) => l.id === levelId) ?? levels[lang === 'ja' ? 1 : 0]
  const preparing = state.busy === 'preparing'

  const start = async () => {
    setError(null)
    try {
      await api.vocab.start(lang, level.id)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div className="test">
      <header className="view-header" data-mode="vocab">
        <div className="view-header-title">
          <small>{t('語彙力特訓')}</small>
          <strong>{t('特訓の準備')}</strong>
        </div>
      </header>
      <div className="test-scroll">
        <div className="paper test-setup">
          <div className="field">
            <span>{t('どちらを特訓しますか')}</span>
            <div className="segmented">
              {(['ja', 'en'] as const).map((value) => (
                <button key={value} aria-pressed={lang === value} onClick={() => setLang(value)}>
                  {value === 'ja' ? t('日本語の言葉') : t('英単語')}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>{t('レベル')}</span>
            <div className="segmented">
              {levels.map((l) => (
                <button key={l.id} aria-pressed={level.id === l.id} onClick={() => setLevelId(l.id)}>
                  {l.label}
                </button>
              ))}
            </div>
            <small>{level.guide}</small>
          </div>

          <div className="field">
            <span>{t('例文の書き方')}</span>
            <SentenceMode state={state} />
            <small>{copy ? t('お手本の例文を、そのまま書き写してもかまいません。') : t('お手本を写した文は数えません。自分で考えた文を書きます。')}</small>
          </div>

          <p className="notice">{tx('このウィンドウに言葉と意味・例文が、もう 1 つのウィンドウに練習用のノートが開きます。ノートに、その言葉を {0} 回と、 例文を {1}〜3 文{2}書いて「書けた！」を押すと、AI がノートを読んで確かめます。合格すると次の言葉へ進み、 「{3}」が上がります。{4}', VOCAB_WORD_TIMES, VOCAB_SENTENCES, copy ? t('（お手本の書き写しでもよい）') : t('（自分で考えて）'), SKILL_LABEL[lang], lang === 'en' && t('英単語では、例文も英語で書きます。'))}
          </p>
          {error && <p className="form-error">{error}</p>}
          <button className="btn btn-primary btn-wide" disabled={preparing} onClick={() => void start()}>
            {preparing ? t('言葉を用意しています…（はじめは 1 分ほどかかります）') : t('特訓を始める')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ───────── 特訓中 ─────────

function Drill({ state }: { state: VocabState }) {
  const skills = useLoad(() => api.skills.get(), [], ['skills'])
  const [error, setError] = useState<string | null>(null)
  const found = findVocabLevel(state.levelId)
  const en = state.lang === 'en'
  const copy = state.sentenceMode === 'copy'
  const word = state.word
  const last = state.last
  // いまの言葉で受けたチェック（まだ合格していないとき）と、合格して次へ進んだ直前の言葉
  const current = last && word && last.word.id === word.id ? last.check : null
  const passed = last && last.check.ok && last.word.id !== word?.id ? last : null
  const goodSentences = current?.sentences.filter((s) => s.ok).length ?? 0
  const skill = skills.data?.values[en ? 'vocabEn' : 'vocabJa'] ?? 0

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
      <header className="view-header" data-mode="vocab">
        <div className="view-header-title">
          <small>{tx('語彙力特訓 ／ {0}・{1}', VOCAB_LANG_LABEL[state.lang], found?.level.label)}
          </small>
          <strong>{tx('クリアした言葉 {0} 語', state.cleared)}</strong>
        </div>
        <div className="view-header-actions">
          <button className="btn btn-mode" data-mode="note" disabled={!state.notebookId} onClick={() => state.notebookId && void api.view.open('note', { notebookId: state.notebookId })}>{t('ノートを開く')}</button>
          <button className="btn" disabled={!!state.busy || !word} onClick={() => void run(() => api.vocab.skip())}>{t('この言葉をとばす')}</button>
          <button className="btn" onClick={() => void run(() => api.vocab.stop())}>{t('やめる')}</button>
        </div>
      </header>

      <div className="drill-body">
        <main className="drill-card">
          {word ? (
            <>
              <p className="drill-reading">
                {word.reading}
                {word.pos && <span className="chip">{word.pos}</span>}
                {en && <SpeakButton text={word.word} label={t('単語を読み上げる')} />}
              </p>
              <h1 className="drill-word" lang={en ? 'en' : 'ja'}>
                {word.word}
              </h1>
              <div>
                <h3>{t('意味')}</h3>
                <p className="drill-meaning">{word.meaning}</p>
              </div>
              <div>
                <h3>{t('例文')}</h3>
                <ul className="drill-examples">
                  {word.examples.map((example, i) => (
                    <li key={i} lang={en ? 'en' : 'ja'}>
                      <span>
                        {example.text}
                        {en && <SpeakButton text={example.text} label={t('例文を読み上げる')} />}
                      </span>
                      {example.translation && <small lang="ja">{example.translation}</small>}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <div className="drill-empty">
              <p>{state.busy === 'preparing' ? t('次の言葉を用意しています…') : t('次の言葉を用意できませんでした。')}</p>
              {!state.busy && (
                <button className="btn btn-primary" onClick={() => void run(() => api.vocab.start(state.lang, state.levelId))}>{t('もう一度用意する')}</button>
              )}
            </div>
          )}
        </main>

        <aside className="drill-side">
          <section className="card">
            <h2 className="section-title">{t('ノートに書くこと')}</h2>
            <ul className="tasks">
              <li data-done={(current?.wordCount ?? 0) >= VOCAB_WORD_TIMES}>
                <i aria-hidden>✓</i>
                <span>{tx('この言葉を {0} 回書く', VOCAB_WORD_TIMES)}</span>
                {current && (
                  <b>
                    {Math.min(current.wordCount, VOCAB_WORD_TIMES)} / {VOCAB_WORD_TIMES}
                  </b>
                )}
              </li>
              <li data-done={goodSentences >= VOCAB_SENTENCES}>
                <i aria-hidden>✓</i>
                <span>{tx('この言葉を使った例文を、{0} {1}〜3 文書く{2}', copy ? t('お手本を書き写すか自分で考えて') : t('自分で考えて'), VOCAB_SENTENCES, en && t('（英語で）'))}
                </span>
                {current && (
                  <b>
                    {Math.min(goodSentences, VOCAB_SENTENCES)} / {VOCAB_SENTENCES}
                  </b>
                )}
              </li>
            </ul>
            <SentenceMode state={state} />
            <p className="muted">{t('書けたら、ノートのウィンドウにある「書けた！」を押してください。手書きでも、タイピングでもかまいません。手書きは、大きめの字のほうが正しく読み取られます（ノートの「罫線」で、間隔を広くできます）。')}</p>
            {state.busy === 'checking' && (
              <p className="arena-waiting">
                {tx('{0}ノートを読んで、確かめています…', <span className="typing" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>)}</p>
            )}
            {error && <p className="form-error">{error}</p>}
          </section>

          {passed && (
            <section className="card check-result" data-ok="true">
              <h2>{tx('「{0}」は合格です', passed.word.word)}</h2>
              <p>{passed.check.feedback}</p>
              <Sentences check={passed.check} />
            </section>
          )}
          {current && (
            <section className="card check-result" data-ok="false">
              <h2>{t('もう少しです')}</h2>
              <p>{current.feedback}</p>
              <Sentences check={current} />
            </section>
          )}

          <section className="card">
            <ul className="meter-list">
              <li>
                <span className="meter-name">
                  <strong>{SKILL_LABEL[state.lang]}</strong>
                  <small>{t('1 語クリアするたびに上がります')}</small>
                </span>
                <span className="meter-track" role="img" aria-label={t('{0} {1} 点', SKILL_LABEL[state.lang], skill.toFixed(1))}>
                  <i style={{ width: `${skill}%` }} />
                </span>
                <span className="meter-figure">
                  {skill.toFixed(1)}
                  <small>{t('点')}</small>
                </span>
              </li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  )
}

function Sentences({ check }: { check: NonNullable<VocabState['last']>['check'] }) {
  if (!check.sentences.length) return null
  return (
    <ul className="check-sentences">
      {check.sentences.map((sentence, i) => (
        <li key={i} data-ok={sentence.ok}>
          <strong>{sentence.text}</strong>
          <small>{sentence.comment}</small>
        </li>
      ))}
    </ul>
  )
}

/** 例文は「自分で考える」か「お手本を書き写してよい」かの切りかえ */
function SentenceMode({ state }: { state: VocabState }) {
  return (
    <div className="segmented" aria-label={t('例文の書き方')}>
      {(
        [
          ['own', t('自分で考える')],
          ['copy', t('書き写してよい')],
        ] as const
      ).map(([mode, label]) => (
        <button key={mode} aria-pressed={state.sentenceMode === mode} onClick={() => void api.vocab.setMode(mode)}>
          {label}
        </button>
      ))}
    </div>
  )
}
