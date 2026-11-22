/**
 * src/main/ai/claude.ts の代わり（Web 版）。同じ名前の部品を、コマンドではなく通信（src/web/ai/transport.ts）で作る。
 * 会話は、これまでのやりとりを毎回まとめて送る（API は会話を覚えないため）。
 */
import type { UsageWindow } from '@shared/types'
import { t } from '@shared/i18n'
import type { Part, Turn } from './providers'
import { ask } from './transport'

export type ClaudeContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } }

export interface ClaudeOptions {
  model: string
  effort: string
  system: string
  jsonSchema?: object
}

export interface RateLimit {
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  status: string
  at: number
}
/** Web 版では、プランの使用割合は届かない */
export const getRateLimit = (): RateLimit | null => null
export const clearRateLimit = (): void => undefined

const toParts = (content: ClaudeContent[]): Part[] => content.map((c) => (c.type === 'text' ? { type: 'text', text: c.text } : { type: 'image', data: c.source.data }))

export class ClaudeSession {
  private turns: Turn[] = []
  private disposed = false

  constructor(private readonly options: ClaudeOptions) {}

  get alive(): boolean {
    return !this.disposed
  }

  private async run(content: ClaudeContent[], onDelta?: (fullText: string) => void): Promise<string> {
    if (this.disposed) throw new Error(t('この会話はすでに閉じられています。'))
    const turns: Turn[] = [...this.turns, { role: 'user', content: toParts(content) }]
    const result = await ask({ provider: 'claude', ...this.options }, turns, onDelta)
    // 画像は、次からは送り直さない（文だけを会話の記録に残す）
    const said: Turn = { role: 'user', content: toParts(content).filter((p) => p.type === 'text') }
    const reply: Turn = { role: 'assistant', content: [{ type: 'text', text: result.text }] }
    this.turns = [...this.turns, said, reply].slice(-40)
    return result.text
  }

  send(content: ClaudeContent[], onDelta?: (fullText: string) => void): Promise<string> {
    return this.run(content, onDelta)
  }

  async sendAndWait(content: ClaudeContent[]): Promise<{ text: string; structured: unknown }> {
    const text = await this.run(content)
    return { text, structured: null }
  }

  async sendStructured<T>(content: ClaudeContent[]): Promise<T> {
    const text = await this.run(content)
    try {
      return JSON.parse(text.replace(/^```(?:json)?\n?|\n?```$/g, '')) as T
    } catch {
      throw new Error(t('AI の返答を読み取れませんでした。もう一度お試しください。'))
    }
  }

  dispose(): void {
    this.disposed = true
  }
}

export async function claudeOnce<T = string>(options: ClaudeOptions, content: ClaudeContent[]): Promise<T> {
  const session = new ClaudeSession(options)
  try {
    if (options.jsonSchema) return await session.sendStructured<T>(content)
    return (await session.sendAndWait(content)).text as T
  } finally {
    session.dispose()
  }
}
