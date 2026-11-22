/**
 * Claude への問い合わせの入口。つなぎ方（src/main/ai/link.ts）に合わせて、次のどちらかで動かす。
 *   - API（src/web/ai/claude.ts）… 利用者の API キー
 *   - この PC の claude のコマンド（claude-cli.ts）… 開発用
 *
 * Web 版では、このファイルごと src/web/ai/claude.ts に差しかわる（vite.web.config.ts）。
 */
import * as api from '../../web/ai/claude'
import * as cli from './claude-cli'
import { usesCli } from './link'

export type { ClaudeContent, ClaudeOptions, RateLimit } from './claude-cli'
type ClaudeContent = cli.ClaudeContent
type ClaudeOptions = cli.ClaudeOptions

interface Inner {
  readonly alive: boolean
  send(content: ClaudeContent[], onDelta?: (fullText: string) => void): Promise<string>
  sendAndWait(content: ClaudeContent[]): Promise<{ text: string; structured: unknown }>
  sendStructured<T>(content: ClaudeContent[]): Promise<T>
  dispose(): void
}

/** 続きの会話。作ったときのつなぎ方で、終わりまで動く（つなぎ方を変えると、会話は作り直される） */
export class ClaudeSession {
  private readonly inner: Inner

  constructor(options: ClaudeOptions) {
    this.inner = usesCli() ? new cli.ClaudeSession(options) : new api.ClaudeSession(options)
  }

  get alive(): boolean {
    return this.inner.alive
  }

  send(content: ClaudeContent[], onDelta?: (fullText: string) => void): Promise<string> {
    return this.inner.send(content, onDelta)
  }

  sendAndWait(content: ClaudeContent[]): Promise<{ text: string; structured: unknown }> {
    return this.inner.sendAndWait(content)
  }

  sendStructured<T>(content: ClaudeContent[]): Promise<T> {
    return this.inner.sendStructured<T>(content)
  }

  dispose(): void {
    this.inner.dispose()
  }
}

export function claudeOnce<T = string>(options: ClaudeOptions, content: ClaudeContent[]): Promise<T> {
  return usesCli() ? cli.claudeOnce<T>(options, content) : api.claudeOnce<T>(options, content)
}

/** プランの使用割合（この PC のコマンドで動かしているときだけ届く） */
export const getRateLimit = (): cli.RateLimit | null => (usesCli() ? cli.getRateLimit() : null)
export const clearRateLimit = (): void => cli.clearRateLimit()
