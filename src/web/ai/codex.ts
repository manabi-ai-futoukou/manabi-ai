/**
 * src/main/ai/codex.ts の代わり（Web 版）。同じ名前の部品を、コマンドではなく通信（src/web/ai/transport.ts）で作る。
 * 「codex」は、アプリの設定での呼び名。Web 版では OpenAI の API（または Sign in with ChatGPT）につながる。
 */
import type { Part } from './providers'
import { ask } from './transport'

export interface CodexOptions {
  model: string
  effort: string
  system: string
  images?: Uint8Array[]
  jsonSchema?: object
}

export async function codexOnce(options: CodexOptions, prompt: string): Promise<string> {
  const images: Part[] = (options.images ?? []).map((image) => ({ type: 'image', data: Buffer.from(image).toString('base64') }))
  const result = await ask({ provider: 'codex', model: options.model, effort: options.effort, system: options.system, jsonSchema: options.jsonSchema }, [{ role: 'user', content: [...images, { type: 'text', text: prompt }] }])
  // 本体側は、決められた形の返事を JSON の文字として受けとる
  return options.jsonSchema ? result.text.replace(/^```(?:json)?\n?|\n?```$/g, '') : result.text
}
