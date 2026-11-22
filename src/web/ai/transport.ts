/**
 * AI へのつなぎ方（Web 版。Windows 版も、API キーと Sign in with ChatGPT は、ここを通る = src/main/ai/link.ts）。
 * 本体側の部品（src/main/ai）からの問い合わせを、選ばれた方式で送る。
 *
 *   relay      … 開発用。付属のサーバーが、この PC の claude / codex のコマンドを動かす（自分のプランの使用量を使う）
 *   own-key    … 利用者が自分の API キーを入れる。キーはこの端末の中だけに置き、ブラウザから直接 API を呼ぶ
 *   server-key … 運営者が用意した API キーを使う。キーはサーバーに置き、利用者ごとの上限と、仕事ごとのモデルの割り当てをサーバーが決める
 *   siwc       … Sign in with ChatGPT。利用者の ChatGPT のプランの枠を使う（OpenAI の側だけ。サインインと呼び出しは、付属のサーバーが行う）
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { AiError, CLAUDE_MODELS, OPENAI_DEFAULT, callProvider, type AiCall, type AiResult, type Turn } from './providers'
import { routed, taskOf, type Task } from './routing'

export type Route = 'relay' | 'own-key' | 'server-key' | 'siwc'
export interface WebAiConfig {
  route: Route
  anthropicKey: string
  openaiKey: string
  /** own-key のとき: 仕事ごとに、モデルを自動で選ぶ（切ると、設定の画面で選んだモデルをいつも使う） */
  routing: boolean
  /** 運営者のキーを使うときに、利用者を見分ける ID（この端末で作った、でたらめな値） */
  userId: string
  /** Sign in with ChatGPT で使うモデル */
  siwcModel: string
}

let FILE = '/user/data/web-ai.json'
let USAGE_FILE = '/user/data/web-ai-usage.json'
let config: WebAiConfig | null = null

/** 設定と、使った量の記録の置き場所を変える（Windows 版は、アプリのデータの置き場に置く） */
export const setFiles = (configFile: string, usageFile: string): void => {
  FILE = configFile
  USAGE_FILE = usageFile
  config = null
  usageRows = null
}

/** API キーを、しまうときに包み、読むときに開く（Windows 版は、Windows の仕組みで暗号化する。Web 版は、そのまま） */
let codec = { seal: (value: string) => value, open: (value: string) => value }
export const setKeyCodec = (next: typeof codec): void => {
  codec = next
  config = null
}

const ALL_ROUTES: Route[] = ['relay', 'own-key', 'server-key', 'siwc']
/** 使ってよい方式（配る版では、しぼる）。はじめのものが、何も選んでいないときの方式になる */
let allowed: Route[] = ALL_ROUTES
export const setAllowedRoutes = (routes: Route[]): void => {
  allowed = routes.filter((route) => ALL_ROUTES.includes(route))
  if (!allowed.length) allowed = ['own-key']
}
export const allowedRoutes = (): Route[] => allowed

/** Sign in with ChatGPT を、付属のサーバーを通さずに呼ぶもの（Windows 版が入れる） */
type SiwcCaller = (call: AiCall, onDelta?: (full: string) => void) => Promise<AiResult>
let siwcCaller: SiwcCaller | null = null
export const setSiwcCaller = (caller: SiwcCaller | null): void => {
  siwcCaller = caller
}

const write = (value: WebAiConfig): void => writeFileSync(FILE, JSON.stringify({ ...value, anthropicKey: codec.seal(value.anthropicKey), openaiKey: codec.seal(value.openaiKey) }), 'utf8')
let base = '/'
export const setBase = (value: string) => {
  base = value.endsWith('/') ? value : `${value}/`
}

export function getAiConfig(): WebAiConfig {
  if (!config) {
    let saved: Partial<WebAiConfig> = {}
    try {
      if (existsSync(FILE)) saved = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<WebAiConfig>
    } catch {
      saved = {}
    }
    config = { route: 'relay', anthropicKey: '', openaiKey: '', routing: true, userId: randomUUID(), siwcModel: OPENAI_DEFAULT, ...saved }
    config.anthropicKey = codec.open(String(config.anthropicKey ?? ''))
    config.openaiKey = codec.open(String(config.openaiKey ?? ''))
    if (!saved.userId) write(config)
  }
  // 使えない方式が書かれていたら（配る版で、開発用の方式が残っていたときなど）、使える方式のはじめのものにする
  return allowed.includes(config.route) ? config : { ...config, route: allowed[0] }
}

export function setAiConfig(patch: Partial<WebAiConfig>): WebAiConfig {
  const next = { ...getAiConfig() }
  if (patch.route && allowed.includes(patch.route)) next.route = patch.route
  if (typeof patch.anthropicKey === 'string') next.anthropicKey = patch.anthropicKey.trim().slice(0, 300)
  if (typeof patch.openaiKey === 'string') next.openaiKey = patch.openaiKey.trim().slice(0, 300)
  if (typeof patch.routing === 'boolean') next.routing = patch.routing
  if (typeof patch.siwcModel === 'string' && patch.siwcModel) next.siwcModel = patch.siwcModel.slice(0, 80)
  config = next
  write(next)
  return next
}

/** いま進めている仕事の種類（画面からの要求を受けたときに、本体側の入口が書く） */
let currentTask: Task = 'other'
export const setTask = (channel: string) => {
  currentTask = taskOf(channel)
}

/** この端末で使った量の記録（料金の目安を、設定の画面に出す） */
export interface UsageRow {
  at: number
  task: Task
  model: string
  route: Route
  input: number
  cached: number
  output: number
  cost: number | null
}
let usageRows: UsageRow[] | null = null
export function getUsageRows(): UsageRow[] {
  if (!usageRows) {
    try {
      usageRows = existsSync(USAGE_FILE) ? (JSON.parse(readFileSync(USAGE_FILE, 'utf8')) as UsageRow[]) : []
    } catch {
      usageRows = []
    }
  }
  return usageRows
}
function recordUsage(row: UsageRow): void {
  usageRows = [...getUsageRows(), row].slice(-500)
  writeFileSync(USAGE_FILE, JSON.stringify(usageRows), 'utf8')
}

export interface AskOptions {
  /** アプリの設定での呼び名（claude / codex） */
  provider: 'claude' | 'codex'
  /** アプリの設定に書かれたモデル（claude は haiku・sonnet・opus。codex は空なら既定） */
  model: string
  effort: string
  system: string
  jsonSchema?: object
}

/** AI に 1 回問い合わせる。onDelta には、そこまでに届いた全文が渡る */
export async function ask(options: AskOptions, turns: Turn[], onDelta?: (full: string) => void): Promise<AiResult> {
  const cfg = getAiConfig()
  const task = currentTask
  const family = options.provider === 'claude' ? 'claude' : 'openai'
  if (cfg.route === 'siwc' && family === 'claude') throw new AiError('Sign in with ChatGPT で使えるのは、OpenAI（Codex）の側だけです。設定で AI を Codex に切りかえてください。', 400, 'siwc_family')

  if (cfg.route === 'own-key') {
    const choice = cfg.routing ? routed(task, family) : { model: family === 'claude' ? (CLAUDE_MODELS[options.model] ?? options.model) : options.model || OPENAI_DEFAULT, effort: options.effort }
    const call: AiCall = { family, model: choice.model, effort: choice.effort, system: options.system, turns, jsonSchema: options.jsonSchema }
    const result = await callProvider({ anthropicKey: cfg.anthropicKey, openai: { token: cfg.openaiKey } }, call, onDelta)
    recordUsage({ at: Date.now(), task, model: result.model, route: cfg.route, ...result.usage, cost: result.cost })
    return result
  }

  // Windows 版の Sign in with ChatGPT は、アプリ本体が、そのまま OpenAI を呼ぶ
  if (cfg.route === 'siwc' && siwcCaller) {
    const result = await siwcCaller({ family: 'openai', model: cfg.siwcModel || OPENAI_DEFAULT, effort: options.effort || 'medium', system: options.system, turns, jsonSchema: options.jsonSchema }, onDelta)
    recordUsage({ at: Date.now(), task, model: result.model, route: cfg.route, ...result.usage, cost: result.cost })
    return result
  }

  // そのほかの方式は、付属のサーバーに頼む（返事は、少しずつ届く）
  const response = await fetch(`${base}api/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ route: { relay: 'cli', 'server-key': 'key', siwc: 'siwc' }[cfg.route], provider: options.provider, model: cfg.route === 'siwc' ? cfg.siwcModel : options.model, effort: options.effort, system: options.system, turns, jsonSchema: options.jsonSchema ?? null, task, userId: cfg.userId }),
  }).catch(() => null)
  if (!response) throw new AiError('AI につなぐサーバーに届きません。サーバーが動いているかを確かめてください。', 0, 'offline')
  if (!response.ok || !response.body) {
    const detail = await response.json().catch(() => ({}) as { error?: string })
    throw new AiError(String(detail.error ?? `サーバーからエラーが返りました（${response.status}）`), response.status, 'server')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: AiResult | null = null
  for (;;) {
    const chunk = await reader.read()
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done })
    let at
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/^data:\s*/, '')
      buffer = buffer.slice(at + 2)
      if (!line.trim()) continue
      const event = JSON.parse(line) as { delta?: string; error?: string; status?: number; done?: AiResult }
      if (event.error) throw new AiError(event.error, event.status ?? 0, 'server')
      if (typeof event.delta === 'string') onDelta?.(event.delta)
      if (event.done) result = event.done
    }
    if (chunk.done) break
  }
  if (!result) throw new AiError('AI の返答が、終わりまで届きませんでした。もう一度お試しください。', 0, 'stream')
  recordUsage({ at: Date.now(), task, model: result.model, route: cfg.route, ...result.usage, cost: result.cost })
  return result
}

/** その AI に、いまの方式でつなげるか（設定の画面の「コマンドが見つかりません」の代わり） */
export function available(provider: string, relay: { claude: boolean; codex: boolean; keys: { claude: boolean; openai: boolean }; siwc: boolean } | null): boolean {
  const cfg = getAiConfig()
  if (cfg.route === 'own-key') return provider === 'claude' ? !!cfg.anthropicKey : !!cfg.openaiKey
  if (!relay) return false
  if (cfg.route === 'relay') return provider === 'claude' ? relay.claude : relay.codex
  if (cfg.route === 'server-key') return provider === 'claude' ? relay.keys.claude : relay.keys.openai
  return provider !== 'claude' && relay.siwc
}
