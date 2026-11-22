import { useEffect, useRef, useState } from 'react'
import type { CharacterDef, ViewParams } from '@shared/types'
import { AiSettings } from '../components/AiSettings'
import { CharacterEditor } from '../components/CharacterEditor'
import { ChatList, Composer, useConversation } from '../components/Chat'
import { Portrait } from '../components/Portrait'
import { PinButton } from '../components/PinButton'
import { api, useLoad } from '../lib/hooks'
import { t, tx } from '@/lib/i18n'

const STARTERS: Record<CharacterDef['role'], string[]> = {
  teacher: [t('この授業でいちばん大事なところを教えてください。'), t('読んでもよくわからないところがありました。'), t('確かめ問題のヒントをください。')],
  classmate: [t('この授業、どこがむずかしかった？'), t('自分の言葉で説明してみるから、聞いてくれる？'), t('身近な例で考えるとどうなるかな？')],
}

/** チャットモード。教科書を読んで疑問に思ったことを、先生や同級生に質問する。 */
export function Chat({ params }: { params: ViewParams }) {
  const characters = useLoad(() => api.characters.list(), [], ['characters'])
  const settings = useLoad(() => api.settings.get(), [], ['settings'])

  const [lessonId, setLessonId] = useState(params.lessonId ?? '')
  // 質問できるのは、いま開いている授業と同じ科目の授業
  const courseId = lessonId ? lessonId.replace(/-\d+-\d+$/, '') : (settings.data?.courseId ?? '')
  const curriculum = useLoad(() => (courseId ? api.content.curriculum(courseId) : Promise.resolve(null)), [courseId], ['content'])
  const [characterId, setCharacterId] = useState(params.characterId ?? '')
  const [input, setInput] = useState('')
  const [quote, setQuote] = useState(params.quote ?? '')
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (params.lessonId) setLessonId(params.lessonId)
    if (params.quote) {
      setQuote(params.quote)
      inputRef.current?.focus()
    }
  }, [params])

  useEffect(() => {
    if (!characterId && settings.data) setCharacterId(settings.data.characterId)
  }, [characterId, settings.data])

  // いま質問している授業を知らせる（学習時間を、どの教科のものとして数えるかに使われる）
  useEffect(() => {
    if (lessonId) void api.view.context({ lessonId })
  }, [lessonId])

  const lessons = (curriculum.data?.units ?? []).flatMap((u) => u.lessons)
  const lesson = lessons.find((l) => l.id === lessonId)
  const character = characters.data?.find((c) => c.id === characterId) ?? characters.data?.[0]
  const conversation = useConversation(lessonId, character, (text) => api.chat.send(lessonId, character!.id, text))
  const { sending, messages, setMessages, face } = conversation

  const send = async (raw: string) => {
    const body = raw.trim()
    if (!body || sending) return
    const text = quote ? t('教科書の「{0}」という部分について質問です。\n{1}', quote, body) : body
    const usedQuote = quote
    setInput('')
    setQuote('')
    if (!(await conversation.submit(text))) {
      setInput(body)
      setQuote(usedQuote)
    }
  }

  const switchCharacter = (id: string) => {
    if (sending) return
    setCharacterId(id)
    void api.settings.set({ characterId: id })
  }

  const clear = async () => {
    if (!character || !lessonId || sending) return
    if (!window.confirm(t('{0}とのこの授業の会話を消します。よろしいですか？', character.name))) return
    await api.chat.clear(lessonId, character.id)
    setMessages([])
  }

  if (!character) return null

  return (
    <div className="debate">
      <aside className="debate-side">
        <Portrait character={character} expression={face} size="xl" />
        <h2>{character.name}</h2>
        <p className="people-role">{character.roleLabel}</p>
        <p className="debate-summary">{character.summary}</p>
        <button className="btn btn-quiet" onClick={() => setEditing(true)}>{t('名前や話し方を変える')}</button>

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

        <h3>{t('応答する AI')}</h3>
        <AiSettings compact />
      </aside>

      <div className="debate-main">
        <header className="view-header" data-mode="chat">
          <div className="view-header-title">
            <small>{t('チャット')}</small>
            <select value={lessonId} disabled={sending} onChange={(e) => setLessonId(e.target.value)} aria-label={t('授業を選ぶ')}>
              {!lesson && <option value="">{t('授業を選んでください')}</option>}
              {lessons
                .filter((l) => l.status !== 'none' || l.deep)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.number} {l.title}
                  </option>
                ))}
            </select>
          </div>
          <div className="view-header-actions">
            <button className="btn btn-mode" data-mode="textbook" disabled={!lessonId} onClick={() => void api.view.open('textbook', { lessonId })}>{t('教科書を開く')}</button>
            <button className="btn btn-mode" data-mode="note" disabled={!lessonId} onClick={() => void api.view.open('note', { lessonId })}>{t('ノートを開く')}</button>
            <button className="btn btn-quiet" disabled={!messages.length || sending} onClick={() => void clear()}>{t('会話を消す')}</button>
            <PinButton className="btn btn-quiet" />
          </div>
        </header>

        <ChatList
          character={character}
          conversation={conversation}
          empty={
            lesson ? (
              <div className="chat-empty">
                <p>{tx('「{0} {1}」について、{2}に聞いてみましょう。', lesson.number, lesson.title, character.name)}</p>
                <div className="starters">
                  {STARTERS[character.role].map((text) => (
                    <button key={text} className="starter" onClick={() => void send(text)}>
                      {text}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="chat-empty">{t('上のメニューから、質問したい授業を選んでください。')}</p>
            )
          }
        />

        <Composer
          value={input}
          onChange={setInput}
          onSubmit={() => void send(input)}
          disabled={!lesson}
          sending={sending}
          inputRef={inputRef}
          placeholder={lesson ? t('{0}に質問する（Enter で送信、Shift + Enter で改行）', character.name) : t('授業を選んでください')}
        >
          {quote && (
            <p className="composer-quote">
              <span>{t('教科書から引用')}</span>
              「{quote}」
              <button type="button" aria-label={t('引用を取り消す')} onClick={() => setQuote('')}>
                ×
              </button>
            </p>
          )}
        </Composer>
      </div>

      {editing && <CharacterEditor character={character} onClose={() => setEditing(false)} />}
    </div>
  )
}
