/**
 * AI の API を呼ぶところ（Web 版）。ブラウザ（ワーカー）と、付属のサーバー（web/server.mjs）の両方から使う。
 *
 * - Claude は、Anthropic の公式 SDK（@anthropic-ai/sdk）で Messages API を呼ぶ。
 * - OpenAI は、Responses API（POST /v1/responses）を呼ぶ。API キーでも、Sign in with ChatGPT のトークンでも同じ形。
 *
 * Node でもそのまま読みこめるよう、ほかのモジュール（@shared など）は読みこまない。
 */
import Anthropic from '@anthropic-ai/sdk'

export type Part = { type: 'text'; text: string } | { type: 'image'; data: string }
export interface Turn {
  role: 'user' | 'assistant'
  content: Part[]
}
export interface AiCall {
  /** claude か openai（アプリの設定では codex と呼んでいる側） */
  family: 'claude' | 'openai'
  /** API のモデルの ID */
  model: string
  effort: string
  system: string
  turns: Turn[]
  /** 指定すると、この JSON Schema に沿った結果を返す */
  jsonSchema?: object
}
export interface Usage {
  input: number
  cached: number
  output: number
}
export interface AiResult {
  text: string
  usage: Usage
  /** 料金の目安（米ドル）。料金表に無いモデルは null */
  cost: number | null
  model: string
}

/** アプリの設定に書くモデルの名前 → API の ID */
export const CLAUDE_MODELS: Record<string, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-2' }
export const OPENAI_DEFAULT = 'gpt-6.2-sol'

/**
 * 料金（100 万トークンあたりの米ドル。入力・キャッシュから読んだ入力・出力）。2026-11-19 に確かめたもの。
 * Claude は Anthropic の資料、OpenAI は developers.openai.com/api/docs/pricing。
 */
export const PRICES: Record<string, [input: number, cached: number, output: number]> = {
  'claude-haiku-5-5': [0.1, 0.01, 0.5],
  'claude-sonnet-5-5': [2, 0.1, 10],
  'claude-opus-5-5': [4, 0.2, 20],
  'claude-fable-5-2': [8, 0.2, 40],
  'gpt-6-luna': [0.1, 0.01, 0.5],
  'gpt-6.1-terra': [1, 0.05, 5],
  'gpt-6.2-sol': [2, 0.1, 10],
  'gpt-6.1-sol': [2, 0.1, 10],
  'gpt-6.2-astra': [8, 0.4, 40],
}

export function costOf(model: string, usage: Usage): number | null {
  const price = PRICES[model]
  if (!price) return null
  return ((usage.input - usage.cached) * price[0] + usage.cached * price[1] + usage.output * price[2]) / 1_000_000
}

/** API が受けつける形の JSON Schema にする（オブジェクトは、決めた項目だけを、すべて必ず返す形にする。数や長さの条件は外す） */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'default'].includes(key)) continue
    out[key] = key === 'properties' && value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, strictSchema(child)])) : strictSchema(value)
  }
  if (out['type'] === 'object' && out['properties'] && typeof out['properties'] === 'object') {
    out['additionalProperties'] = false
    out['required'] = Object.keys(out['properties'] as object)
  }
  return out
}

export class AiError extends Error {
  status: number
  code: string
  constructor(message: string, status = 0, code = '') {
    super(message)
    this.status = status
    this.code = code
  }
}

// ───────── Claude（Messages API） ─────────

export async function callClaude(apiKey: string, call: AiCall, onDelta?: (full: string) => void): Promise<AiResult> {
  // 利用者が自分のキーを入れて、自分の端末から呼ぶ方式なので、ブラウザからの呼び出しを許す
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 })
  const effort = (['low', 'medium', 'high', 'xhigh', 'max'].includes(call.effort) ? call.effort : 'medium') as 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  try {
    const stream = client.messages.stream({
      model: call.model,
      max_tokens: 32000,
      system: call.system,
      messages: call.turns.map((turn) => ({
        role: turn.role,
        content: turn.content.map((part) =>
          part.type === 'text' ? { type: 'text' as const, text: part.text } : { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: part.data } },
        ),
      })),
      output_config: {
        effort,
        ...(call.jsonSchema ? { format: { type: 'json_schema' as const, schema: strictSchema(call.jsonSchema) as Record<string, unknown> } } : {}),
      },
    })
    if (onDelta) stream.on('text', (_delta, snapshot) => onDelta(snapshot))
    const message = await stream.finalMessage()
    if (message.stop_reason === 'refusal') throw new AiError('AI が、この内容には答えられないと判断しました。', 0, 'refusal')
    if (message.stop_reason === 'max_tokens') throw new AiError('AI の返答が長すぎて、途中で切れました。', 0, 'max_tokens')
    const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
    const cached = message.usage.cache_read_input_tokens ?? 0
    const usage: Usage = { input: message.usage.input_tokens + cached + (message.usage.cache_creation_input_tokens ?? 0), cached, output: message.usage.output_tokens }
    return { text, usage, cost: costOf(call.model, usage), model: call.model }
  } catch (error) {
    if (error instanceof AiError) throw error
    if (error instanceof Anthropic.AuthenticationError) throw new AiError('Claude の API キーが正しくありません。', 401, 'auth')
    if (error instanceof Anthropic.RateLimitError) throw new AiError('Claude の API の利用が混み合っています。少し待ってから、もう一度お試しください。', 429, 'rate_limit')
    if (error instanceof Anthropic.APIError) throw new AiError(`Claude の API からエラーが返りました（${error.status ?? '?'}）: ${error.message}`, error.status ?? 0, 'api')
    throw error
  }
}

// ───────── OpenAI（Responses API） ─────────

export interface OpenAiAuth {
  /** API キー、または Sign in with ChatGPT のアクセストークン */
  token: string
  /** Sign in with ChatGPT（ChatGPT のプランの枠を使う）。使えない項目を送らない */
  planUsage?: boolean
}

export async function callOpenAI(auth: OpenAiAuth, call: AiCall, onDelta?: (full: string) => void): Promise<AiResult> {
  const body = {
    model: call.model,
    instructions: call.system,
    input: call.turns.map((turn) => ({
      role: turn.role,
      content: turn.content.map((part) =>
        part.type === 'text' ? { type: turn.role === 'assistant' ? 'output_text' : 'input_text', text: part.text } : { type: 'input_image', image_url: `data:image/png;base64,${part.data}`, detail: 'auto' },
      ),
    })),
    reasoning: { effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(call.effort) ? call.effort : 'medium' },
    ...(call.jsonSchema ? { text: { format: { type: 'json_schema', name: 'result', schema: strictSchema(call.jsonSchema), strict: true } } } : {}),
    // 会話は OpenAI に保存させない（Sign in with ChatGPT では、store: false と stream: true が必須）
    store: false,
    stream: true,
  }
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  })
  if (!response.ok || !response.body) throw openAiError(response.status, await response.text().catch(() => ''), auth.planUsage)

  let text = ''
  let usage: Usage = { input: 0, cached: 0, output: 0 }
  let done = false
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const handle = (raw: string) => {
    const data = raw
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('')
    if (!data || data === '[DONE]') return
    let event: any
    try {
      event = JSON.parse(data)
    } catch {
      return
    }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      text += event.delta
      onDelta?.(text)
    } else if (event.type === 'response.completed') {
      done = true
      const u = event.response?.usage ?? {}
      usage = { input: Number(u.input_tokens) || 0, cached: Number(u.input_tokens_details?.cached_tokens) || 0, output: Number(u.output_tokens) || 0 }
      // まとめて届いた本文があれば、そちらを正とする
      const full = (event.response?.output ?? []).flatMap((item: any) => (item.type === 'message' ? item.content : [])).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('')
      if (full) text = full
    } else if (event.type === 'response.failed' || event.type === 'error') {
      const error = event.response?.error ?? event.error ?? event
      throw openAiError(Number(error.status) || 0, JSON.stringify({ error }), auth.planUsage)
    } else if (event.type === 'response.incomplete') {
      throw new AiError(`AI の返答が途中で止まりました（${event.response?.incomplete_details?.reason ?? '理由は不明'}）。`, 0, 'incomplete')
    } else if (event.type === 'response.refusal.done') {
      throw new AiError('AI が、この内容には答えられないと判断しました。', 0, 'refusal')
    }
  }
  for (;;) {
    const chunk = await reader.read()
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done })
    let at
    while ((at = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buffer.slice(0, at)
      buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, '')
      handle(raw)
    }
    if (chunk.done) break
  }
  if (buffer.trim()) handle(buffer)
  if (!done) throw new AiError('AI の返答が、終わりまで届きませんでした。もう一度お試しください。', 0, 'stream')
  return { text, usage, cost: auth.planUsage ? null : costOf(call.model, usage), model: call.model }
}

function openAiError(status: number, body: string, planUsage = false): AiError {
  let code = ''
  let message = ''
  try {
    const parsed = JSON.parse(body)
    code = String(parsed.error?.code ?? parsed.code ?? '')
    message = String(parsed.error?.message ?? parsed.detail ?? parsed.message ?? '')
  } catch {
    message = body.slice(0, 300)
  }
  // Sign in with ChatGPT で決められている知らせ
  if (code === 'subscription_sharing_usage_limit_exceeded') return new AiError('ChatGPT のプランの、いま使える枠を使い切りました。時間をおくか、ChatGPT の設定（使用量）を確かめてください。', 429, code)
  if (code === 'subscription_sharing_user_not_eligible') return new AiError('この ChatGPT のアカウントでは、プランの枠をアプリで使えません（Plus・Pro の利用者が対象です）。', 403, code)
  if (code === 'subscription_sharing_invalid_user') return new AiError('ChatGPT へのサインインが切れました。もう一度サインインしてください。', 401, code)
  if (status === 401) return new AiError(planUsage ? 'ChatGPT へのサインインが切れました。もう一度サインインしてください。' : 'OpenAI の API キーが正しくありません。', 401, code || 'auth')
  if (status === 429) return new AiError(`OpenAI の利用の上限に達しました。少し待ってから、もう一度お試しください。${message ? `（${message}）` : ''}`, 429, code || 'rate_limit')
  return new AiError(`OpenAI からエラーが返りました（${status || '?'}${code ? `・${code}` : ''}）: ${message}`, status, code || 'api')
}

export function callProvider(auth: { anthropicKey?: string; openai?: OpenAiAuth }, call: AiCall, onDelta?: (full: string) => void): Promise<AiResult> {
  if (call.family === 'claude') {
    if (!auth.anthropicKey) throw new AiError('Claude の API キーが設定されていません。', 401, 'no_key')
    return callClaude(auth.anthropicKey, call, onDelta)
  }
  if (!auth.openai?.token) throw new AiError('OpenAI の API キーが設定されていません。', 401, 'no_key')
  return callOpenAI(auth.openai, call, onDelta)
}
