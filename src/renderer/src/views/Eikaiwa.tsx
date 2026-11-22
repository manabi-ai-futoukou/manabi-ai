import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { comparePronunciation, type PronunciationResult } from '@shared/pronounce'
import { EIKAIWA_CHANNEL, type CharacterDef, type EikaiwaSettings } from '@shared/types'
import { AiSettings } from '../components/AiSettings'
import { useConversation } from '../components/Chat'
import { MicButton } from '../components/MicButton'
import { Portrait } from '../components/Portrait'
import { SpeakButton } from '../components/SpeakButton'
import { SpeechSetup } from '../components/SpeechSetup'
import { api, errorMessage, useLoad } from '../lib/hooks'
import { speak, stopSpeaking, useCanSpeak } from '../lib/speech'
import { getLang, t, tx } from '@/lib/i18n'

const STARTERS = ['Hello! How are you today?', 'What do you like to do in your free time?', t('好きな食べ物について話したいです。')]
const hasJapanese = (text: string) => /[ぁ-んァ-ヶ一-龠]/.test(text)

/** 相手の返事を、英語の部分と、日本語訳（とワンポイント）に分ける */
function splitReply(text: string): { en: string; ja: string } {
  const [en, ...rest] = text.split(/\n\s*-{3,}\s*\n?/)
  return { en: en.trim(), ja: rest.join('\n').trim() }
}

/**
 * 英会話モード。先生や同級生（AI）と、英語で会話する。
 *   1. 言いたいことを英語か日本語で書く → 2. 声に出して言う（聞き取れたら送られる）→ 3. 相手が英語と日本語訳で返事をする
 */
export function Eikaiwa() {
  const characters = useLoad(() => api.characters.list(), [], ['characters'])
  const settings = useLoad(() => api.settings.get(), [], ['settings'])
  const level = useLoad(() => api.eikaiwa.level(), [], ['settings', 'notes', 'chat', 'test'])
  const skills = useLoad(() => api.skills.get(), [], ['skills'])
  const speech = useLoad(() => api.speech.status(), [], ['speech', 'settings'])
  const [characterId, setCharacterId] = useState('')
  const [draft, setDraft] = useState('')
  /** 声に出して言う英文。null の間は、言いたいことを書く段階 */
  const [target, setTarget] = useState<string | null>(null)
  const [translating, setTranslating] = useState(false)
  const [attempt, setAttempt] = useState<PronunciationResult | null>(null)
  const [tries, setTries] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const voiceReady = useCanSpeak('en-US')
  /** 自分が送った直後の返事だけを読み上げる（開いたときに、過去の返事を読み上げないように） */
  const awaiting = useRef(false)

  useEffect(() => {
    if (!characterId && settings.data) setCharacterId(settings.data.characterId)
  }, [characterId, settings.data])
  useEffect(() => stopSpeaking, [])

  const character = characters.data?.find((c) => c.id === characterId) ?? characters.data?.[0]
  const conversation = useConversation(EIKAIWA_CHANNEL, character, (text) => api.eikaiwa.say(character!.id, text))
  const { messages, sending, live, waitingText, face } = conversation
  const options: EikaiwaSettings = settings.data?.eikaiwa ?? { tts: true, unlimited: false, showJa: true }

  useLayoutEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, live?.text, waitingText])

  // 返事が届いたら、英語の部分だけを読み上げる
  useEffect(() => {
    const last = messages[messages.length - 1]
    if (!awaiting.current || sending || last?.role !== 'assistant') return
    awaiting.current = false
    if (options.tts) void speak(splitReply(last.text).en)
  }, [messages, sending, options.tts])

  if (!character || !settings.data) return null

  const setOption = (patch: Partial<EikaiwaSettings>) => {
    const eikaiwa = { ...options, ...patch }
    settings.setData({ ...settings.data!, eikaiwa })
    void api.settings.set({ eikaiwa })
    if (patch.tts === false) stopSpeaking()
  }

  const reset = () => {
    setTarget(null)
    setAttempt(null)
    setTries(0)
  }

  /** 1 → 2: 書いたものを、声に出す英文にする（日本語なら英語に直す） */
  const prepare = async (raw: string) => {
    const body = raw.trim()
    if (!body || translating || sending) return
    setError(null)
    setAttempt(null)
    setTries(0)
    if (!hasJapanese(body)) return setTarget(body)
    setTranslating(true)
    try {
      setTarget(await api.eikaiwa.translate(body))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setTranslating(false)
    }
  }

  /** 2 → 3: 言えた英文を相手に送る */
  const send = async (english: string) => {
    if (sending) return
    stopSpeaking()
    awaiting.current = true
    const kept = draft
    setDraft('')
    reset()
    if (!(await conversation.submit(english))) {
      awaiting.current = false
      setDraft(kept)
    }
  }

  const judge = (heard: string) => {
    if (!target) return
    const result = comparePronunciation(target, heard)
    setAttempt(result)
    setTries((n) => n + 1)
    // 伝わったことが見えるよう、少し間をおいてから送る
    if (result.pass) window.setTimeout(() => void send(target), 900)
  }

  const switchCharacter = (id: string) => {
    if (sending) return
    setCharacterId(id)
    reset()
    void api.settings.set({ characterId: id })
  }

  const clear = async () => {
    if (sending || !window.confirm(t('{0}との英会話の記録を消します。よろしいですか？', character.name))) return
    await api.chat.clear(EIKAIWA_CHANNEL, character.id)
    conversation.setMessages([])
  }

  const skill = skills.data?.values.english ?? 0
  const words = target ? (attempt?.words ?? target.split(/\s+/).map((text) => ({ text, ok: null as boolean | null }))) : []

  return (
    <div className="debate eikaiwa">
      <aside className="debate-side">
        <Portrait character={character} expression={face} size="xl" />
        <h2>{character.name}</h2>
        <p className="people-role">{character.roleLabel}</p>

        <h3>{t('話す相手')}</h3>
        <ul className="debate-people">
          {characters.data?.map((c) => (
            <li key={c.id}>
              <button className={c.id === character.id ? 'person person-active' : 'person'} disabled={sending} onClick={() => switchCharacter(c.id)}>
                <Portrait character={c} size="sm" />
                <span>
                  <strong>{c.name}</strong>
                  <small>{c.roleLabel}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>

        <h3>{t('会話のレベル')}</h3>
        <p className="eikaiwa-level">{level.data?.label ?? ''}</p>
        <label className="check">
          <input type="checkbox" checked={options.unlimited} onChange={(e) => setOption({ unlimited: e.target.checked })} />{t('レベルの制限を外す')}</label>
        <small>{t('ふだんは、英語の授業で進んだところまでの英語で話します。')}</small>

        <h3>{t('音声')}</h3>
        <label className="check">
          <input type="checkbox" checked={options.tts} disabled={!voiceReady} onChange={(e) => setOption({ tts: e.target.checked })} />{t('相手の英語を読み上げる')}</label>
        {!voiceReady && (
          <p className="notice voice-missing">{t('この PC には、英語を読み上げる音声が入っていません。Windows の「設定 → 時刻と言語 → 音声認識 → 音声の管理 → 音声の追加」で「英語（米国）」を追加し、アプリを開き直すと、読み上げられるようになります。')}</p>
        )}
        <label className="check">
          <input type="checkbox" checked={options.showJa} disabled={getLang() !== 'ja'} onChange={(e) => setOption({ showJa: e.target.checked })} />{t('日本語訳を表示する')}</label>

        <h3>{t('英会話力')}</h3>
        <p className="eikaiwa-skill">
          <span className="meter-track" role="img" aria-label={t('英会話力 {0} 点', skill.toFixed(1))}>
            <i style={{ width: `${skill}%` }} />
          </span>
          <b>{skill.toFixed(1)}</b>
          <small>{tx('点（会話 {0} 回）', skills.data?.counts.english ?? 0)}</small>
        </p>

        <h3>{t('応答する AI')}</h3>
        <AiSettings compact />
      </aside>

      <div className="debate-main">
        <header className="view-header" data-mode="eikaiwa">
          <div className="view-header-title">
            <small>{t('英会話')}</small>
            <strong>{tx('{0}と英語で話す', character.name)}</strong>
          </div>
          <div className="view-header-actions">
            <button className="btn btn-quiet" disabled={!messages.length || sending} onClick={() => void clear()}>{t('会話を消す')}</button>
          </div>
        </header>

        <div className="chat" ref={listRef}>
          {messages.length === 0 && !sending && (
            <div className="chat-empty">
              <p>{tx('{0}に、英語で話しかけてみましょう。言いたいことは、日本語で書いてもかまいません。', character.name)}</p>
              <div className="starters">
                {STARTERS.map((text) => (
                  <button key={text} className="starter" onClick={() => void prepare(text)}>
                    {text}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="message message-user">
                <div className="bubble bubble-user" lang="en">
                  {m.text}
                </div>
              </div>
            ) : (
              <Reply key={m.id} character={character} text={m.text} expression={m.expression} showJa={options.showJa || getLang() !== 'ja'} />
            ),
          )}
          {waitingText !== null && (
            <div className="message message-user">
              <div className="bubble bubble-user" lang="en">
                {waitingText}
              </div>
            </div>
          )}
          {sending && <Reply character={character} text={live?.text ?? ''} expression={face} showJa={options.showJa || getLang() !== 'ja'} typing={!live?.text} />}
          {conversation.error && (
            <p className="form-error chat-error" role="alert">
              {conversation.error}
            </p>
          )}
        </div>

        {target === null ? (
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault()
              void prepare(draft)
            }}
          >
            <p className="composer-quote">
              {tx('{0}英語でも日本語でもかまいません。日本語で書くと、いまのレベルの英語に直します。', <span>{t('1. 言いたいことを書く')}</span>)}</p>
            {error && <p className="form-error">{error}</p>}
            <div className="composer-row">
              <textarea
                value={draft}
                rows={2}
                maxLength={400}
                placeholder={t('例: I like music. ／ 週末は何をしますか？')}
                disabled={sending || translating}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void prepare(draft)
                  }
                }}
              />
              <MicButton lang="auto" disabled={sending || translating} onText={(text) => setDraft((current) => (current ? `${current} ${text}` : text))} />
              <button className="btn btn-primary" type="submit" disabled={sending || translating || !draft.trim()}>
                {sending ? t('返答中…') : translating ? t('英語にしています…') : hasJapanese(draft) ? t('英語にする') : t('次へ')}
              </button>
            </div>
          </form>
        ) : (
          <div className="composer say">
            <p className="composer-quote">
              {tx('{0}マイクのボタンを押して、下の英文を言いましょう。正しく伝わると、{1}に送られます。', <span>{t('2. 声に出して言う')}</span>, character.name)}</p>
            <p className="say-target" lang="en">
              {words.map((word, i) => (
                <span key={i} data-ok={word.ok === null ? undefined : word.ok}>
                  {word.text}{' '}
                </span>
              ))}
              <SpeakButton text={target} label={t('お手本を聞く')} />
            </p>
            {attempt && (
              <p className="say-result" data-pass={attempt.pass} role="status">
                {attempt.pass ? (
                  <strong>{t('伝わりました！ 送ります…')}</strong>
                ) : (
                  <>
                    {tx('{0}聞き取れた英語: {1} ／ 色のついた単語を意識して、もう一度言ってみましょう。', <strong>{tx('おしい！（{0}% 伝わりました）', Math.round(attempt.score * 100))}</strong>, <q lang="en">{attempt.heard || t('（なし）')}</q>)}</>
                )}
              </p>
            )}
            {!speech.data?.ready && <SpeechSetup compact />}
            <div className="say-actions">
              <MicButton lang="en" size="lg" label={t('英語で言う')} disabled={sending || attempt?.pass} onText={judge} />
              <button className="btn" disabled={sending} onClick={reset}>{t('書き直す')}</button>
              {(tries >= 3 || !speech.data?.ready) && !attempt?.pass && (
                <button className="btn" disabled={sending} onClick={() => void send(target)}>{t('発音の確認をとばして送る')}</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Reply({ character, text, expression, showJa, typing }: { character: CharacterDef; text: string; expression?: string; showJa: boolean; typing?: boolean }) {
  const { en, ja } = splitReply(text)
  return (
    <div className="message message-assistant">
      <Portrait character={character} expression={expression} size="sm" />
      <div className="bubble bubble-assistant reply">
        {typing ? (
          <span className="typing" aria-label={t('考えています')}>
            <i />
            <i />
            <i />
          </span>
        ) : (
          <>
            <p className="reply-en" lang="en">
              {en}
              <SpeakButton text={en} label={t('英語を読み上げる')} />
            </p>
            {showJa && ja && <p className="reply-ja">{ja}</p>}
          </>
        )}
      </div>
    </div>
  )
}
