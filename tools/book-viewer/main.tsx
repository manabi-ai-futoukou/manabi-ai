// 参考書と問題集の見本を読むページ（試作）。本文は、アプリの教科書と同じ部品（Markdown）で表示する。
// 見本の中身は、tools/book-trial.mjs --export が書く data.js（window.BOOK_SAMPLES）から読む。
import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import '../../src/renderer/src/styles.css'
import './viewer.css'
import { Markdown } from '../../src/renderer/src/components/Markdown'

interface Sample {
  id: string
  unit: string
  course: string
  title: string
  kind: string
  kindLabel: string
  body: string
  /** 点検の結果（1 行）と、残っている指摘 */
  check: string
  remaining: string[]
  /** 何回直した版か（0 は、書いたまま） */
  fixes: number
}
/** 見本のひとまとまり（書いたモデルごとに 1 つ。tag は、試しに付けた名前。Sonnet は空文字） */
interface SampleSet {
  tag: string
  at: string
  model: string
  judge: string
  samples: Sample[]
}
declare global {
  interface Window {
    BOOK_SETS?: SampleSet[]
  }
}

interface Problem {
  n: string
  level: string
  aim: string
  question: string
  answer: string
  explanation: string
}
/** 問題集の Markdown を、問題ごとに分ける（tools/book-trial.mjs の parseDrill と同じ決まり） */
function parseDrill(body: string): { title: string; problems: Problem[] } {
  const parts = body.split(/^### 問\s*(\d+)\s*【([^】]+)】[^\n]*$/m)
  const problems: Problem[] = []
  for (let i = 1; i + 2 < parts.length; i += 3) {
    const [head = '', afterAnswer = ''] = (parts[i + 2] ?? '').split(/^#### 解答[^\n]*$/m)
    const [answer = '', explanation = ''] = afterAnswer.split(/^#### 解説[^\n]*$/m)
    const aim = /^ねらい[:：]\s*(.+)$/m.exec(head)?.[1] ?? ''
    problems.push({ n: parts[i], level: parts[i + 1].trim(), aim, question: head.replace(/^ねらい[:：][^\n]*\n?/m, '').trim(), answer: answer.trim(), explanation: explanation.trim() })
  }
  return { title: /^# (.+)$/m.exec(parts[0] ?? '')?.[1] ?? '', problems }
}

function Drill({ body }: { body: string }) {
  const { title, problems } = useMemo(() => parseDrill(body), [body])
  const [open, setOpen] = useState(false)
  // 「すべて開く」を押すたびに、中の details を作り直す（1 問ずつ開け閉めした状態は、そのとき捨てる）
  const [round, setRound] = useState(0)
  return (
    <>
      <div className="md">
        <h1>{title}</h1>
      </div>
      <div className="bv-bar">
        <span>{problems.length} 問</span>
        <button
          onClick={() => {
            setOpen(!open)
            setRound(round + 1)
          }}
        >
          {open ? '解答と解説を、すべて閉じる' : '解答と解説を、すべて開く'}
        </button>
      </div>
      {problems.map((p) => (
        <section className="bv-problem" key={`${p.n}-${round}`}>
          <header>
            <b>問 {p.n}</b>
            <span className="bv-tag">{p.level}</span>
          </header>
          {p.aim && <div className="bv-aim">ねらい: {p.aim}</div>}
          <Markdown>{p.question}</Markdown>
          <details open={open}>
            <summary>解答と解説を見る</summary>
            <h4>解答</h4>
            <Markdown>{p.answer}</Markdown>
            <h4>解説</h4>
            <Markdown>{p.explanation}</Markdown>
          </details>
        </section>
      ))}
    </>
  )
}

function App() {
  const sets = window.BOOK_SETS ?? []
  // 場所は「#<試しの名前>/<見本の id>」。モデルを切りかえても、同じ単元・同じ種類を開いたままにする
  const [where, setWhere] = useState(() => {
    const hash = decodeURIComponent(location.hash.slice(1))
    const at = hash.indexOf('/')
    return { tag: at >= 0 ? hash.slice(0, at) : '', id: at >= 0 ? hash.slice(at + 1) : hash }
  })
  const data = sets.find((s) => s.tag === where.tag) ?? sets[0]
  const samples = data?.samples ?? []
  const id = where.id || samples[0]?.id || ''
  const setId = (next: string) => setWhere({ tag: data?.tag ?? '', id: next })
  useEffect(() => {
    history.replaceState(null, '', `#${encodeURIComponent(`${data?.tag ?? ''}/${id}`)}`)
  }, [data, id])
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [id])
  const units = useMemo(() => {
    const map = new Map<string, Sample[]>()
    for (const s of samples) map.set(s.unit, [...(map.get(s.unit) ?? []), s])
    return [...map.values()]
  }, [samples])
  const current = samples.find((s) => s.id === id) ?? samples[0]
  if (!current) return <p style={{ padding: 24 }}>見本がありません。app フォルダで node --no-warnings tools/book-trial.mjs --export を実行してください。</p>
  return (
    <div className="bv">
      <nav className="bv-side">
        <h1>参考書と問題集の見本</h1>
        {sets.length > 1 && (
          <div className="bv-models">
            <small>書いたモデル</small>
            <div className="bv-links">
              {sets.map((s) => (
                <button key={s.tag} aria-current={s === data} onClick={() => setWhere({ tag: s.tag, id })}>
                  {s.model.replace(/^Claude /, '')}
                </button>
              ))}
            </div>
          </div>
        )}
        <span className="muted">
          {data?.model} が書き、{data?.judge} が点検した試作です。人の確認は受けていません。
        </span>
        {units.map((list) => (
          <div className="bv-unit" key={list[0].unit}>
            <small>{list[0].course}</small>
            <b>{list[0].title}</b>
            <div className="bv-links">
              {list.map((s) => (
                <button key={s.id} aria-current={s.id === current.id} onClick={() => setId(s.id)}>
                  {s.kindLabel}
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <main className="bv-main">
        <div className="bv-head">
          <span className="bv-tag">{current.kindLabel}</span>
          <span>
            {current.course}・{current.title}
            {sets.length > 1 && `（${data?.model.replace(/^Claude /, '')}）`}
          </span>
        </div>
        <div className="bv-note">
          {current.check}
          {current.fixes > 0 ? `（指摘を ${current.fixes} 回直したあとの版です）` : '（書いたままの版です）'}
          {current.remaining.length > 0 && ' まだ残っている指摘:'}
          {current.remaining.length > 0 && (
            <ul>
              {current.remaining.map((text, i) => (
                <li key={i}>{text}</li>
              ))}
            </ul>
          )}
        </div>
        {current.kind.startsWith('drill') ? (
          <Drill body={current.body} />
        ) : (
          <div className="bv-paper">
            <Markdown>{current.body}</Markdown>
          </div>
        )}
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
