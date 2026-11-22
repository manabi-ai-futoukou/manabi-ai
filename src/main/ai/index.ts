import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { splitExpression } from '@shared/expression'
import {
  COACH_CHANNEL,
  EIKAIWA_CHANNEL,
  type AiStatus,
  type CharacterDef,
  type ChatMessage,
  type EvaluateRequest,
  type EvaluateResult,
  type NoteEvaluation,
  type TranscribeResult,
} from '@shared/types'
import { rewardNote } from '../affinity'
import { getCharacter, getCharacters, getLesson } from '../content'
import {
  addEvaluation,
  getChat,
  getChatsForLesson,
  getNotebook,
  getSettings,
  saveChat,
} from '../store'
import { askStructured } from './ask'
import { ClaudeSession } from './claude'
import { codexOnce } from './codex'
import {
  EVALUATION_SCHEMA,
  TRANSCRIBE_SCHEMA,
  transcribeSystemPrompt,
  coachSystemPrompt,
  debateSystemPrompt,
  eikaiwaSystemPrompt,
  evaluationSystemPrompt,
  evaluationUserPrompt,
  formatHistory,
  type EvaluationOutput,
} from './prompts'
import { getLang, t } from '@shared/i18n'

const isJaLang = () => getLang() === 'ja'

// ───────── CLI が使えるかの確認 ─────────

function canRun(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      resolve(false)
    }, 8000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

export async function aiStatus(): Promise<AiStatus> {
  const [claude, codex] = await Promise.all([canRun('claude'), canRun('codex')])
  return { claude, codex }
}

// ───────── 会話（ディベートとコミュニケーションで共通） ─────────

interface LiveSession {
  session: ClaudeSession
  /** モデルや人物設定が変わったら作り直すための目印 */
  signature: string
  idleTimer: NodeJS.Timeout | null
}

const sessions = new Map<string, LiveSession>()
const busy = new Set<string>()
const IDLE_MS = 15 * 60 * 1000

function closeSession(key: string): void {
  const live = sessions.get(key)
  if (!live) return
  if (live.idleTimer) clearTimeout(live.idleTimer)
  live.session.dispose()
  sessions.delete(key)
}

export function closeAllSessions(): void {
  for (const key of [...sessions.keys()]) closeSession(key)
}

/** 設定や人物が変わったときに呼ぶ。次の発言で新しい条件の会話を始める。 */
export function resetSessions(): void {
  closeAllSessions()
}

interface Exchange {
  /** 記録の置き場所。ディベートなら授業の ID、コミュニケーションなら TALK_CHANNEL */
  channel: string
  characterId: string
  /** 記録に残す発言 */
  text: string
  /** AI に渡す発言（日時の情報などを添えたもの） */
  wire: string
  /** これまでの会話を受け取って、指示文を作る */
  buildSystem: (character: CharacterDef, history: ChatMessage[]) => string
  /** これまでの会話を日時つきで AI に見せるか */
  historyWithTime: boolean
  /** 指示文の内容が変わったら会話を作り直すための目印（人物設定のほかに変わりうるもの） */
  signature?: string
  onDelta: (messageId: string, fullText: string) => void
}

/** 1 回のやりとり（生徒の発言 → 登場人物の返答）を行い、記録に残す */
async function exchange(e: Exchange): Promise<ChatMessage[]> {
  const key = `${e.channel}::${e.characterId}`
  if (busy.has(key)) throw new Error(t('前の返答を待っています。少しお待ちください。'))
  const character = getCharacter(e.characterId)
  const { ai } = getSettings()
  const log = getChat(e.channel, e.characterId)
  const history = log.messages.slice(-30)
  const replyId = randomUUID()

  busy.add(key)
  try {
    let raw: string
    if (ai.provider === 'claude') {
      const signature = JSON.stringify([ai, character.name, character.persona, character.speech, e.signature ?? ''])
      let live = sessions.get(key)
      if (live && (live.signature !== signature || !live.session.alive)) {
        closeSession(key)
        live = undefined
      }
      if (!live) {
        // 新しく起動するときだけ、これまでの会話を指示文に含めて続きから話せるようにする
        const system = e.buildSystem(character, history)
        live = { session: new ClaudeSession({ model: ai.model, effort: ai.effort, system }), signature, idleTimer: null }
        sessions.set(key, live)
      }
      if (live.idleTimer) clearTimeout(live.idleTimer)
      try {
        raw = await live.session.send([{ type: 'text', text: e.wire }], (full) => e.onDelta(replyId, full))
      } catch (error) {
        closeSession(key)
        throw error
      }
      live.idleTimer = setTimeout(() => closeSession(key), IDLE_MS)
      live.idleTimer.unref()
    } else {
      // codex は会話を続けて持てないので、これまでのやりとりを毎回渡す
      const past = history.length ? t('# これまでの会話\n{0}\n\n', formatHistory(history, character, e.historyWithTime)) : ''
      const prompt = t('{0}# 生徒の今回の発言\n{1}\n\n{2}として、今回の発言に返答してください。', past, e.wire, character.name)
      raw = await codexOnce({ model: ai.model, effort: ai.effort, system: e.buildSystem(character, []) }, prompt)
      e.onDelta(replyId, raw)
    }

    const { expression, text: replyText } = splitExpression(raw)
    const now = Date.now()
    const added: ChatMessage[] = [
      { id: randomUUID(), role: 'user', text: e.text, at: now - 1 },
      {
        id: replyId,
        role: 'assistant',
        text: replyText.trim(),
        expression: expression && character.expressions[expression] ? expression : character.defaultExpression,
        at: now,
      },
    ]
    await saveChat({ lessonId: e.channel, characterId: e.characterId, messages: [...log.messages, ...added] })
    return added
  } finally {
    busy.delete(key)
  }
}

/** ディベートモード: 授業の内容について質問する */
export function sendChat(
  lessonId: string,
  characterId: string,
  text: string,
  onDelta: Exchange['onDelta'],
): Promise<ChatMessage[]> {
  // 小学校の授業で、学び直し向けの本文しか無い場合はそちらを使う
  const lesson = getLesson(lessonId) ?? getLesson(lessonId, 'deep')
  if (!lesson) throw new Error(t('この授業の教科書がまだ用意されていません。'))
  return exchange({
    channel: lessonId,
    characterId,
    text,
    wire: text,
    buildSystem: (character, history) => debateSystemPrompt(character, lesson, history),
    historyWithTime: false,
    onDelta,
  })
}

/** ディベートの途中で、先生に相談する。brief は、いまのディベートの状況（論題、立場、これまでの発言）。 */
export function sendCoach(brief: string, text: string, onDelta: Exchange['onDelta']): Promise<ChatMessage[]> {
  return exchange({
    channel: COACH_CHANNEL,
    characterId: coach().id,
    text,
    wire: t('（アプリからの情報: いまのディベートの状況）\n{0}\n\n# 生徒からの相談\n{1}', brief, text),
    buildSystem: coachSystemPrompt,
    historyWithTime: false,
    onDelta,
  })
}

/** 英会話モード: 声に出して言えた英文を、相手に送る。levelGuide は、生徒の英語のレベルの説明。 */
export function sendEikaiwa(characterId: string, text: string, levelGuide: string, onDelta: Exchange['onDelta']): Promise<ChatMessage[]> {
  return exchange({
    channel: EIKAIWA_CHANNEL,
    characterId,
    text,
    wire: text,
    buildSystem: (character, history) => eikaiwaSystemPrompt(character, history, levelGuide),
    historyWithTime: false,
    signature: levelGuide,
    onDelta,
  })
}

/** 相談にのる先生 */
export const coach = () => getCharacters().find((c) => c.role === 'teacher') ?? getCharacters()[0]

export async function clearChat(channel: string, characterId: string): Promise<void> {
  closeSession(`${channel}::${characterId}`)
  await saveChat({ lessonId: channel, characterId, messages: [] })
}

// ───────── ノートの評価 ─────────

const clampScore = (value: unknown) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)))

/** 比較のために、空白や記号を取り除く */
function normalize(text: string): string {
  return text.replace(/[\s　、。，．,.!！?？「」『』（）()【】[\]・:：;；*#$\\{}|_`>〜~=＝+＋\-−]/g, '')
}

/**
 * ノートの文章のうち、教科書やディベートの文章と同じ並びになっている割合。
 * 12 文字のかたまりが一致するかで数える、機械的な参考値。
 */
export function copyRate(note: string, sources: string[]): number | null {
  const size = 12
  const target = normalize(note)
  if (target.length < size * 3) return null
  const known = new Set<string>()
  for (const source of sources) {
    const s = normalize(source)
    for (let i = 0; i + size <= s.length; i++) known.add(s.slice(i, i + size))
  }
  let covered = 0
  let reach = -1
  for (let i = 0; i + size <= target.length; i++) {
    if (!known.has(target.slice(i, i + size))) continue
    const from = Math.max(i, reach + 1)
    covered += i + size - from
    reach = i + size - 1
  }
  return covered / target.length
}

/** 一度に文字起こしするページ数の上限 */
export const MAX_TRANSCRIBE_PAGES = 4

/**
 * 手書きの文字起こしだけをする（評価はしない。好感度も変わらない）。
 * 渡すのは、手書きの線だけを描いたページの画像（タイピングした文字は、もう文字なので入れない）。
 */
export async function transcribeNote(request: EvaluateRequest): Promise<TranscribeResult> {
  if (!getNotebook(request.notebookId)) throw new Error(t('ノートが見つかりません。'))
  if (!request.pages?.length) throw new Error(t('手書きのあるページがありません。'))
  if (request.pages.length > MAX_TRANSCRIBE_PAGES) throw new Error(t('一度に文字起こしできるのは {0} ページまでです。', MAX_TRANSCRIBE_PAGES))
  const pages = request.pages.map((p) => Number(p.page))
  const images = request.pages.map((p) => Buffer.from(String(p.image).replace(/^data:image\/png;base64,/, ''), 'base64'))
  const prompt = isJaLang()
    ? `添付した画像は、順に ${pages.map((p) => `p.${p}`).join('、')} です。それぞれを文字に起こしてください。`
    : `The attached images are, in order, ${pages.map((p) => `p.${p}`).join(', ')}. Transcribe each of them.`
  const output = await askStructured<{ transcripts: string[] }>(getSettings().ai, transcribeSystemPrompt(), prompt, TRANSCRIBE_SCHEMA, images)
  const result: TranscribeResult = {}
  pages.forEach((page, i) => {
    result[page] = String(output.transcripts?.[i] ?? '').trim()
  })
  return result
}

export async function evaluateNote(request: EvaluateRequest): Promise<EvaluateResult> {
  const notebook = getNotebook(request.notebookId)
  if (!notebook) throw new Error(t('ノートが見つかりません。'))
  if (notebook.kind === 'test') throw new Error(t('テスト用のノートは評価できません。'))
  if (notebook.kind === 'memo') throw new Error(t('メモは、先生の評価の対象ではありません。'))
  if (!request.pages.length) throw new Error(t('まだ何も書かれていません。ノートに書いてから、もう一度お試しください。'))
  if (request.pages.length > 8) throw new Error(t('一度に見てもらえるのは 8 ページまでです。'))

  const { ai } = getSettings()
  const lesson = notebook.lessonId ? (getLesson(notebook.lessonId) ?? getLesson(notebook.lessonId, 'deep')) : null
  const evaluator = getCharacters().find((c) => c.role === 'teacher') ?? getCharacters()[0]
  const pages = request.pages.map((p) => p.page)
  const images = request.pages.map((p) => Buffer.from(p.image.replace(/^data:image\/png;base64,/, ''), 'base64'))

  const typedTexts: Record<number, string[]> = {}
  for (const page of pages) {
    typedTexts[page] = (notebook.pages[page - 1]?.texts ?? []).map((t) => t.text.trim()).filter(Boolean)
  }
  const chats = notebook.lessonId ? getChatsForLesson(notebook.lessonId) : []
  const debate = chats
    .map((log) => formatHistory(log.messages.slice(-40), getCharacter(log.characterId)))
    .join('\n\n')

  const output = await askStructured<EvaluationOutput>(
    ai,
    evaluationSystemPrompt(evaluator),
    evaluationUserPrompt({ lesson, pages, typedTexts, debate }),
    EVALUATION_SCHEMA,
    images,
  )

  const transcripts: Record<number, string> = {}
  pages.forEach((page, i) => {
    transcripts[page] = String(output.transcripts?.[i] ?? '').trim()
  })
  const noteText = pages.map((p) => `${transcripts[p]}\n${typedTexts[p].join('\n')}`).join('\n')
  const sources = [lesson?.body ?? '', ...chats.flatMap((log) => log.messages.filter((m) => m.role === 'assistant').map((m) => m.text))]

  const evaluation: NoteEvaluation = {
    id: randomUUID(),
    notebookId: notebook.id,
    lessonId: notebook.lessonId,
    at: Date.now(),
    ai,
    evaluatorId: evaluator.id,
    understanding: { score: clampScore(output.understanding?.score), comment: String(output.understanding?.comment ?? '') },
    application: { score: clampScore(output.application?.score), comment: String(output.application?.comment ?? '') },
    creativity: { score: clampScore(output.creativity?.score), comment: String(output.creativity?.comment ?? '') },
    overall: String(output.overall ?? ''),
    advice: String(output.advice ?? ''),
    copyRate: copyRate(noteText, sources),
    pages,
  }
  await addEvaluation(evaluation)
  const average = (evaluation.understanding.score + evaluation.application.score + evaluation.creativity.score) / 3
  return { evaluation, transcripts, reward: rewardNote(notebook.id, notebook.title, average) }
}
