import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { splitExpression } from '@shared/expression'
import type { CharacterDef, ChatMessage } from '@shared/types'
import { api, errorMessage } from '../lib/hooks'
import { Markdown } from './Markdown'
import { MicButton } from './MicButton'
import { Portrait } from './Portrait'
import { t } from '@/lib/i18n'

/**
 * 1 人の相手との会話の状態（記録の読み込み、送信、少しずつ届く返答）。
 * ディベートとコミュニケーションの両方で使う。
 *
 * @param channel 記録の置き場所（授業の ID、または自由会話の目印）
 * @param send 発言を送る処理。追加されたやりとり（生徒の発言と返答）を返す。
 */
export function useConversation(
  channel: string,
  character: CharacterDef | undefined,
  send: (text: string) => Promise<ChatMessage[]>,
) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [waitingText, setWaitingText] = useState<string | null>(null)
  const [streaming, setStreaming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const characterId = character?.id

  // 相手や授業を切り替えたら、その組み合わせの記録を読み込む
  useEffect(() => {
    if (!channel || !characterId) return
    let cancelled = false
    setMessages([])
    setError(null)
    void api.chat.load(channel, characterId).then((log) => !cancelled && setMessages(log.messages))
    return () => {
      cancelled = true
    }
  }, [channel, characterId])

  // 返答が少しずつ届く
  useEffect(() => {
    return api.chat.onDelta((delta) => {
      if (delta.lessonId === channel && delta.characterId === characterId) setStreaming(delta.text)
    })
  }, [channel, characterId])

  const sending = waitingText !== null

  /** 送信する。成功したら true。失敗したら、入力をもどせるよう false を返す。 */
  const submit = async (text: string): Promise<boolean> => {
    if (!text.trim() || !channel || !characterId || sending) return false
    setWaitingText(text)
    setStreaming(null)
    setError(null)
    try {
      const added = await send(text)
      setMessages((prev) => [...prev, ...added])
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    } finally {
      setWaitingText(null)
      setStreaming(null)
    }
  }

  const live = streaming !== null ? splitExpression(streaming) : null
  const lastReply = [...messages].reverse().find((m) => m.role === 'assistant')
  // 返答を待つ間は「考え中」、届きはじめたらその表情、ふだんは最後の返答の表情
  const face = !character
    ? undefined
    : sending
      ? (live?.expression ?? ('thinking' in character.expressions ? 'thinking' : character.defaultExpression))
      : (lastReply?.expression ?? character.defaultExpression)

  return { messages, setMessages, waitingText, live, sending, error, submit, face }
}

export type Conversation = ReturnType<typeof useConversation>

/** 会話の表示。新しい発言が増えたら、いちばん下まで自動で送る。 */
export function ChatList({
  character,
  conversation,
  empty,
}: {
  character: CharacterDef
  conversation: Conversation
  /** まだ何も話していないときに表示するもの */
  empty: ReactNode
}) {
  const { messages, waitingText, live, sending, error, face } = conversation
  const listRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, live?.text, waitingText])

  return (
    <div className="chat" ref={listRef}>
      {messages.length === 0 && !sending ? empty : null}
      {messages.map((m) => (
        <Bubble key={m.id} character={character} role={m.role} text={m.text} expression={m.expression} />
      ))}
      {waitingText !== null && <Bubble character={character} role="user" text={waitingText} />}
      {sending && <Bubble character={character} role="assistant" text={live?.text ?? ''} expression={face} typing={!live?.text} />}
      {error && (
        <p className="form-error chat-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function Bubble({
  character,
  role,
  text,
  expression,
  typing,
}: {
  character: CharacterDef
  role: ChatMessage['role']
  text: string
  expression?: string
  typing?: boolean
}) {
  if (role === 'user') {
    return (
      <div className="message message-user">
        <div className="bubble bubble-user">{text}</div>
      </div>
    )
  }
  return (
    <div className="message message-assistant">
      <Portrait character={character} expression={expression} size="sm" />
      <div className="bubble bubble-assistant">
        {typing ? (
          <span className="typing" aria-label={t('考えています')}>
            <i />
            <i />
            <i />
          </span>
        ) : (
          <Markdown>{text}</Markdown>
        )}
      </div>
    </div>
  )
}

/** 発言の入力欄。Enter で送信、Shift + Enter で改行。マイクで話して入力することもできる（送る前に確かめられる）。 */
export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  sending,
  placeholder,
  inputRef,
  children,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled?: boolean
  sending: boolean
  placeholder: string
  inputRef?: React.RefObject<HTMLTextAreaElement | null>
  /** 入力欄の上に置くもの（教科書からの引用など） */
  children?: ReactNode
}) {
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      {children}
      <div className="composer-row">
        <textarea
          ref={inputRef}
          value={value}
          rows={2}
          maxLength={2000}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              onSubmit()
            }
          }}
        />
        <MicButton disabled={disabled} onText={(text) => onChange(value ? `${value}${text}` : text)} />
        <button className="btn btn-primary" type="submit" disabled={disabled || sending || !value.trim()}>
          {sending ? t('返答中…') : t('送る')}
        </button>
      </div>
    </form>
  )
}
