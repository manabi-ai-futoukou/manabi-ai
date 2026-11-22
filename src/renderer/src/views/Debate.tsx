import { useEffect, useRef, useState } from 'react'
import { COACH_CHANNEL, type CharacterDef, type DebatePhase, type DebateSession, type DebateSide, type ViewParams } from '@shared/types'
import { ChatList, Composer, useConversation } from '../components/Chat'
import { Markdown } from '../components/Markdown'
import { MicButton } from '../components/MicButton'
import { Portrait } from '../components/Portrait'
import { api, errorMessage, useLoad } from '../lib/hooks'
import { LOCALE, t, tx } from '@/lib/i18n'

const SIDE: Record<DebateSide, string> = { pro: t('肯定側'), con: t('否定側') }
const PHASE: Record<DebatePhase, string> = { constructive: t('立論'), cross: t('反対尋問'), rebuttal: t('反駁'), closing: t('最終弁論') }
/** 自分の番で、何を書けばよいかの手がかり */
const GUIDE: Record<DebatePhase, string> = {
  constructive: t('自分の立場の主張を 1〜2 点にしぼり、それぞれに理由と具体例を添えて述べましょう。'),
  cross: t('相手の主張の、あいまいな点・矛盾している点・根拠の弱い点を、質問の形で突きましょう。'),
  rebuttal: t('相手からの質問や批判に、正面から答えましょう。自分の主張がなお成り立つ理由を示します。'),
  closing: t('これまでの議論をふり返り、なぜ自分の立場のほうがすぐれているかをまとめましょう。新しい論点は出しません。'),
}
const phaseName = (slot: { phase: DebatePhase; round: number }) => `${PHASE[slot.phase]}${slot.round ? t('（{0} 回目）', slot.round) : ''}`

/**
 * ディベートモード。1 つの論題について、同級生（AI）と肯定側・否定側に分かれて意見を交わし、
 * 第三者のジャッジ（AI）を論理で説得する。途中で、先生に考え方を相談できる。
 */
export function Debate({ params }: { params: ViewParams }) {
  const [id, setId] = useState<string | null>(params.debateId ?? null)
  const session = useLoad(() => (id ? api.debate.get(id) : Promise.resolve(null)), [id], ['debate'])
  const characters = useLoad(() => api.characters.list(), [], ['characters'])
  useEffect(() => {
    if (params.debateId) setId(params.debateId)
  }, [params.debateId])

  if (!characters.data) return null
  if (id && session.data) return <Arena session={session.data} characters={characters.data} onLeave={() => setId(null)} />
  return <Setup characters={characters.data} onStarted={(s) => setId(s.id)} onOpen={setId} />
}

// ───────── 準備 ─────────

function Setup({ characters, onStarted, onOpen }: { characters: CharacterDef[]; onStarted: (s: DebateSession) => void; onOpen: (id: string) => void }) {
  const past = useLoad(() => api.debate.list(), [], ['debate'])
  const classmates = characters.filter((c) => c.role === 'classmate')
  const [topic, setTopic] = useState('')
  const [side, setSide] = useState<DebateSide | 'random'>('pro')
  const [opponentId, setOpponentId] = useState(classmates[0]?.id ?? '')
  const [rounds, setRounds] = useState(1)
  const [thinking, setThinking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const suggest = async () => {
    setThinking(true)
    setError(null)
    try {
      setTopic(await api.debate.topic())
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setThinking(false)
    }
  }
  const start = async () => {
    try {
      onStarted(await api.debate.start({ topic, side, opponentId, rounds }))
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const result = (d: DebateSession) => (!d.verdict ? t('途中') : d.verdict.winner === 'draw' ? t('引き分け') : d.verdict.winner === d.userSide ? t('勝ち') : t('負け'))

  return (
    <div className="test">
      <header className="view-header" data-mode="debate">
        <div className="view-header-title">
          <small>{t('ディベート')}</small>
          <strong>{t('ディベートの準備')}</strong>
        </div>
      </header>
      <div className="test-scroll">
        <div className="paper test-setup">
          <div className="field">
            <span>{t('論題（テーマ）')}</span>
            <div className="answer-row">
              <textarea
                className="answer"
                rows={2}
                value={topic}
                maxLength={200}
                placeholder={t('例: 中学校の制服は廃止すべきである')}
                aria-label={t('論題')}
                onChange={(e) => setTopic(e.target.value)}
              />
              <MicButton label={t('マイクで話して論題を入力する')} onText={(text) => setTopic(`${topic}${text}`.slice(0, 200))} />
            </div>
            <button className="btn" disabled={thinking} onClick={() => void suggest()}>
              {thinking ? t('論題を考えています…') : t('AI に論題を決めてもらう')}
            </button>
          </div>

          <div className="field">
            <span>{t('あなたの立場')}</span>
            <div className="segmented">
              {(
                [
                  ['pro', t('肯定側')],
                  ['con', t('否定側')],
                  ['random', t('おまかせ（どちらかに決まります）')],
                ] as const
              ).map(([value, label]) => (
                <button key={value} aria-pressed={side === value} onClick={() => setSide(value)}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>{t('相手（あなたが選ばなかった立場になります）')}</span>
            <div className="opponents">
              {classmates.map((c) => (
                <button key={c.id} className={c.id === opponentId ? 'person person-active' : 'person'} title={c.summary} onClick={() => setOpponentId(c.id)}>
                  <Portrait character={c} size="sm" />
                  <span>
                    <strong>{c.name}</strong>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>{t('反対尋問と反駁をくり返す回数')}</span>
            <div className="segmented">
              {[1, 2, 3].map((n) => (
                <button key={n} aria-pressed={rounds === n} onClick={() => setRounds(n)}>
                  {tx('{0} 回', n)}</button>
              ))}
            </div>
          </div>

          <p className="notice">{t('立論 → 反対尋問 → 反駁（くり返し）→ 最終弁論 の順に、交代で発言します。最後に、第三者のジャッジが議論の中身だけで勝敗を決めます。 途中で、先生に考え方を相談できます。勝つと「ディベート力」が上がります。')}</p>
          {error && <p className="form-error">{error}</p>}
          <button className="btn btn-primary btn-wide" disabled={topic.trim().length < 4 || !opponentId} onClick={() => void start()}>{t('ディベートを始める')}</button>
        </div>

        {!!past.data?.length && (
          <div className="paper test-history">
            <h2 className="section-title">{t('これまでのディベート')}</h2>
            <ul>
              {past.data.slice(0, 20).map((d) => (
                <li key={d.id}>
                  <button onClick={() => onOpen(d.id)}>
                    <span>{new Date(d.startedAt).toLocaleDateString(LOCALE, { month: 'numeric', day: 'numeric' })}</span>
                    <strong>{d.topic}</strong>
                    <span>{SIDE[d.userSide]}</span>
                    <b>{result(d)}</b>
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

// ───────── ディベート中 ─────────

function Arena({ session, characters, onLeave }: { session: DebateSession; characters: CharacterDef[]; onLeave: () => void }) {
  const opponent = characters.find((c) => c.id === session.opponentId) ?? characters[0]
  const teacher = characters.find((c) => c.role === 'teacher') ?? characters[0]
  const [input, setInput] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [coachOpen, setCoachOpen] = useState(true)
  const [question, setQuestion] = useState('')
  const coach = useConversation(COACH_CHANNEL, teacher, (text) => api.debate.coach(session.id, text))
  const listRef = useRef<HTMLDivElement>(null)
  const requested = useRef('')

  const myTurn = !!session.next && session.next.side === session.userSide
  const pending = !session.verdict && !myTurn

  const advance = async (text: string | null) => {
    setWorking(true)
    setError(null)
    try {
      await api.debate.advance(session.id, text)
      if (text !== null) setInput('')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setWorking(false)
    }
  }

  // 相手の番や判定が残っていれば、進めてもらう（開き直したときの続きもここで再開する）
  useEffect(() => {
    const key = `${session.id}:${session.turns.length}`
    if (!pending || working || requested.current === key) return
    requested.current = key
    void advance(null)
  }, [session.id, session.turns.length, pending, working])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [session.turns.length, session.verdict])

  const ask = async () => {
    const body = question.trim()
    if (!body || coach.sending) return
    setQuestion('')
    if (!(await coach.submit(body))) setQuestion(body)
  }

  const verdict = session.verdict
  const won = verdict && verdict.winner === session.userSide

  return (
    <div className="arena">
      <header className="view-header" data-mode="debate">
        <div className="view-header-title">
          <small>{tx('ディベート ／ あなた: {0}　{1}: {2}', SIDE[session.userSide], opponent.name, SIDE[session.userSide === 'pro' ? 'con' : 'pro'])}
          </small>
          <strong>{session.topic}</strong>
        </div>
        <div className="view-header-actions">
          <button className="btn btn-mode" data-mode="textbook" aria-pressed={coachOpen} onClick={() => setCoachOpen((open) => !open)}>
            {tx('{0}に相談', teacher.name)}</button>
          <button className="btn" onClick={onLeave}>
            {verdict ? t('新しいディベート') : t('一覧へ')}
          </button>
        </div>
      </header>

      <div className="arena-body">
        <main className="arena-main">
          <div className="arena-turns" ref={listRef}>
            {session.turns.map((turn) => (
              <article key={turn.id} className="turn" data-speaker={turn.speaker} data-side={turn.side}>
                {turn.speaker === 'opponent' && <Portrait character={opponent} size="sm" />}
                <div className="turn-body">
                  <p className="turn-head">
                    {tx('{0}{1}・{2}', <span className="chip" data-side={turn.side}>
                      {SIDE[turn.side]}
                    </span>, phaseName(turn), turn.speaker === 'user' ? t('あなた') : opponent.name)}
                  </p>
                  <Markdown>{turn.text}</Markdown>
                </div>
              </article>
            ))}

            {pending && (
              <p className="arena-waiting">
                <span className="typing" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
                {session.next ? t('{0}が {1} を考えています…', opponent.name, phaseName(session.next)) : t('ジャッジが判定しています…')}
              </p>
            )}

            {verdict && (
              <section className="verdict" data-result={verdict.winner === 'draw' ? 'draw' : won ? 'win' : 'lose'}>
                <h2>{tx('判定: {0}{1}', verdict.winner === 'draw' ? t('引き分け') : t('{0}の勝ち', SIDE[verdict.winner]), <small>{verdict.winner === 'draw' ? '' : won ? t('（あなたの勝ちです。ディベート力が上がりました）') : t('（{0}の勝ちです）', opponent.name)}</small>)}
                </h2>
                <ul className="meter-list">
                  {(['pro', 'con'] as const).map((side) => (
                    <li key={side}>
                      <span className="meter-name">
                        <strong>{SIDE[side]}</strong>
                        <small>{side === session.userSide ? t('あなた') : opponent.name}</small>
                      </span>
                      <span className="meter-track" role="img" aria-label={t('{0} {1} 点', SIDE[side], verdict.scores[side])}>
                        <i style={{ width: `${verdict.scores[side]}%` }} />
                      </span>
                      <span className="meter-figure">
                        {verdict.scores[side]}
                        <small>{t('点')}</small>
                      </span>
                    </li>
                  ))}
                </ul>
                <h3>{t('ジャッジの講評')}</h3>
                <Markdown>{verdict.reasons}</Markdown>
                <h3>{t('あなたへの助言')}</h3>
                <Markdown>{verdict.advice}</Markdown>
              </section>
            )}
            {error && <p className="form-error">{error}</p>}
          </div>

          {myTurn && session.next && (
            <Composer
              value={input}
              onChange={setInput}
              onSubmit={() => void advance(input)}
              sending={working}
              placeholder={t('{0}を書く（Enter で発言、Shift + Enter で改行）', phaseName(session.next))}
            >
              <p className="composer-quote">
                <span>{tx('あなたの番: {0}', phaseName(session.next))}</span>
                {GUIDE[session.next.phase]}
              </p>
            </Composer>
          )}
        </main>

        {coachOpen && (
          <aside className="arena-coach">
            <header>
              <Portrait character={teacher} expression={coach.face} size="md" />
              <div>
                <strong>{tx('{0}に相談', teacher.name)}</strong>
                <small>{t('考え方や進め方を聞けます。発言は自分で書きましょう。')}</small>
              </div>
            </header>
            <ChatList
              character={teacher}
              conversation={coach}
              empty={<p className="chat-empty muted">{t('「反対尋問では何を聞けばいいですか？」のように、気軽に聞いてみましょう。')}</p>}
            />
            <Composer value={question} onChange={setQuestion} onSubmit={() => void ask()} sending={coach.sending} placeholder={t('先生に相談する')} />
          </aside>
        )}
      </div>
    </div>
  )
}
