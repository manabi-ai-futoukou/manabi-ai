/**
 * OpenAI（アプリの設定での呼び名は「codex」）への問い合わせの入口。つなぎ方（src/main/ai/link.ts）に合わせて、次のどちらかで動かす。
 *   - API（src/web/ai/codex.ts）… 利用者の API キー、または Sign in with ChatGPT
 *   - この PC の codex のコマンド（codex-cli.ts）… 開発用
 *
 * Web 版では、このファイルごと src/web/ai/codex.ts に差しかわる（vite.web.config.ts）。
 */
import * as api from '../../web/ai/codex'
import * as cli from './codex-cli'
import { usesCli } from './link'

export type { CodexOptions } from './codex-cli'

export function codexOnce(options: cli.CodexOptions, prompt: string): Promise<string> {
  return usesCli() ? cli.codexOnce(options, prompt) : api.codexOnce(options, prompt)
}
