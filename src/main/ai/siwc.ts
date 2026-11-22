/**
 * Sign in with ChatGPT（Windows 版）。利用者の ChatGPT のプラン（Plus・Pro）の枠で、OpenAI の Responses API を呼ぶ。
 *
 * OpenAI の決まり（developers.openai.com/siwc/）どおりの流れ:
 *   ブラウザで許可 → http://127.0.0.1:1455/auth/callback にもどる → トークンを受けとる → Responses API を呼ぶ
 * オープンソースで、利用者の PC の中で動くアプリは、申し込みなしで使える（入口は client_id=dynamic_agent_client）。
 *
 * トークンは、この PC の中に、Windows の仕組み（safeStorage）で暗号化して置く。画面（レンダラー）には渡さない。
 * Web 版の付属のサーバー（web/server.mjs）にも、同じ流れのものがある。
 */
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { t } from '@shared/i18n'
import { AiError, OPENAI_DEFAULT, callProvider, type AiCall, type AiResult } from '../../web/ai/providers'
import { dataDir } from '../paths'

const AUTH = 'https://auth.openai.com'
const AUTHORIZE = `${AUTH}/api/accounts/authorize`
const TOKEN = `${AUTH}/api/accounts/oauth/token`
const RESOURCE = 'https://api.openai.com/v1'
const REDIRECT = 'http://127.0.0.1:1455/auth/callback'
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'

interface Cred {
  hostId?: string
  clientId?: string
  accessToken?: string
  refreshToken?: string
  idToken?: string
  expiresAt?: number
  scope?: string
  email?: string
  sub?: string
}

const credFile = () => join(dataDir(), 'siwc.json')
let cred: Cred | null = null

function load(): Cred {
  if (cred) return cred
  cred = {}
  try {
    if (existsSync(credFile())) {
      const raw = readFileSync(credFile(), 'utf8')
      cred = JSON.parse(raw.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64')) : raw) as Cred
    }
  } catch {
    // 読めない（別の PC から写したなど）ときは、サインインし直してもらう
    cred = {}
  }
  return cred
}

function save(): void {
  const text = JSON.stringify(load())
  writeFileSync(credFile(), safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(text).toString('base64')}` : text, 'utf8')
}

const b64url = (buffer: Buffer): string => buffer.toString('base64url')

export interface SiwcState {
  signedIn: boolean
  email: string
  /** ChatGPT のプランの枠を、アプリで使う許可が出ているか */
  planUsage: boolean
}

export function siwcState(): SiwcState {
  const c = load()
  return { signedIn: !!c.accessToken && !!c.refreshToken, email: c.email ?? '', planUsage: String(c.scope ?? '').split(/\s+/).includes('chatgpt.tokens.use.direct') }
}

/** ID トークンを確かめる（OpenAI の公開鍵で署名を確かめ、発行者・あて先・期限・1 回きりの値を見る） */
async function verifyIdToken(idToken: string, clientId: string, nonce: string): Promise<{ sub?: string; email?: string }> {
  const [head, body, signature] = idToken.split('.')
  const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as { kid?: string; alg?: string }
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { iss?: string; aud?: string | string[]; exp?: number; nonce?: string; sub?: string; email?: string }
  const jwks = (await (await fetch(`${AUTH}/.well-known/jwks.json`)).json()) as { keys: ({ kid?: string } & Record<string, unknown>)[] }
  const jwk = jwks.keys.find((key) => key.kid === header.kid)
  if (!jwk || header.alg !== 'RS256') throw new Error(t('ID トークンの署名の鍵が見つかりません'))
  if (!verify('RSA-SHA256', Buffer.from(`${head}.${body}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'))) throw new Error(t('ID トークンの署名が正しくありません'))
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (claims.iss !== AUTH || !audience.includes(clientId) || (claims.exp ?? 0) * 1000 < Date.now() || claims.nonce !== nonce) throw new Error(t('ID トークンの中身が正しくありません'))
  return claims
}

interface TokenBody {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  scope?: string
}

async function tokenRequest(fields: Record<string, string>): Promise<TokenBody> {
  const response = await fetch(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(fields) })
  const body = (await response.json().catch(() => ({}))) as TokenBody & { error?: string }
  if (!response.ok) throw Object.assign(new Error(t('トークンを受けとれませんでした（{0}・{1}）', response.status, body.error ?? '')), { code: String(body.error ?? '') })
  return body
}

function storeTokens(body: TokenBody): void {
  const c = load()
  c.accessToken = body.access_token
  if (body.refresh_token) c.refreshToken = body.refresh_token
  if (body.id_token) c.idToken = body.id_token
  c.expiresAt = Date.now() + (Number(body.expires_in) || 3600) * 1000
  if (body.scope) c.scope = body.scope
  save()
}

/** サインインの途中の状態（1 回につき 1 つ） */
let pending: { state: string; nonce: string; verifier: string; at: number } | null = null
let callbackServer: Server | null = null
function stopCallbackServer(): void {
  callbackServer?.close()
  callbackServer = null
}

const escapeHtml = (text: string): string => text.replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch] ?? ch)
const page = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;padding:48px;line-height:1.8"><h1 style="font-size:1.3rem">${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`

/**
 * サインインを始める。ブラウザで開く URL を返す（開くのは、呼んだ側）。
 * サインインが終わったら（できても、できなくても）、onDone を呼ぶ。
 */
export function startSignIn(onDone: () => void): Promise<string> {
  const c = load()
  c.hostId ??= `urn:uuid:${randomUUID()}`
  save()
  const verifier = b64url(randomBytes(32))
  const mine = { state: b64url(randomBytes(16)), nonce: b64url(randomBytes(16)), verifier, at: Date.now() }
  pending = mine
  const params = new URLSearchParams({
    // はじめてのときは、登録の入口（dynamic_agent_client）。2 回めからは、発行された client_id を使う
    client_id: c.clientId ?? 'dynamic_agent_client',
    ext_agent_host_id: c.hostId,
    response_type: 'code',
    redirect_uri: REDIRECT,
    scope: SCOPE,
    resource: RESOURCE,
    state: mine.state,
    nonce: mine.nonce,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  })
  if (!c.clientId) params.set('agent_name_hint', 'Manabi AI')
  else if (c.idToken) params.set('id_token_hint', c.idToken)

  stopCallbackServer()
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', REDIRECT)
    if (url.pathname !== '/auth/callback') {
      res.writeHead(404).end()
      return
    }
    const finish = (title: string, text: string) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page(title, text))
      pending = null
      setTimeout(stopCallbackServer, 500)
      onDone()
    }
    void (async () => {
      try {
        if (!pending || url.searchParams.get('state') !== pending.state) return finish(t('サインインできませんでした'), t('サインインの手続きが、このアプリから始めたものと合いません。学びアイにもどって、もう一度お試しください。'))
        if (url.searchParams.get('error')) return finish(t('サインインをやめました'), t('許可されなかったので、サインインしていません。このタブを閉じて、学びアイにもどってください。'))
        const issued = url.searchParams.get('client_id')
        // 2 回めからのサインインで、ちがう client_id が返ってきたら受けつけない
        if (c.clientId && issued && issued !== c.clientId) return finish(t('サインインできませんでした'), t('登録の情報が、前のサインインと合いません。'))
        const clientId = c.clientId ?? issued
        if (!clientId) return finish(t('サインインできませんでした'), t('アプリの登録が終わっていません。もう一度お試しください。'))
        const body = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code: url.searchParams.get('code') ?? '', code_verifier: pending.verifier, redirect_uri: REDIRECT, resource: RESOURCE })
        const claims = await verifyIdToken(body.id_token ?? '', clientId, pending.nonce)
        c.clientId = clientId
        c.sub = claims.sub
        c.email = claims.email ?? ''
        storeTokens(body)
        finish(t('サインインできました'), t('このタブを閉じて、学びアイにもどってください。'))
      } catch (error) {
        finish(t('サインインできませんでした'), error instanceof Error ? error.message : String(error))
      }
    })()
  })
  callbackServer = server
  return new Promise((done, fail) => {
    server.once('error', (error) => fail(new Error(t('サインインの受け口（127.0.0.1:1455）を開けませんでした: {0}', error.message))))
    server.listen(1455, '127.0.0.1', () => {
      // 10 分たっても終わらなければ、受け口を閉じる
      setTimeout(() => pending === mine && stopCallbackServer(), 10 * 60_000).unref()
      done(`${AUTHORIZE}?${params}`)
    })
  })
}

/** 使えるアクセストークンを返す（期限が近ければ、取りかえる。取りかえは、1 つずつ順に行う） */
let refreshing: Promise<unknown> = Promise.resolve()
function accessToken(): Promise<string> {
  const run = refreshing.then(async () => {
    const c = load()
    if (!c.accessToken || !c.refreshToken) throw new AiError(t('ChatGPT にサインインしていません。設定の画面の「AI のつなぎ方」からサインインしてください。'), 401, 'siwc_signed_out')
    if ((c.expiresAt ?? 0) - Date.now() > 5 * 60_000) return c.accessToken
    try {
      storeTokens(await tokenRequest({ grant_type: 'refresh_token', client_id: c.clientId ?? '', refresh_token: c.refreshToken, resource: RESOURCE }))
      return load().accessToken ?? ''
    } catch (error) {
      if (/invalid_grant|invalid_refresh_token|token_expired|refresh_token/.test((error as { code?: string }).code ?? '')) {
        // 期限切れや取り消し。トークンだけを捨てる（登録の情報は残すので、次のサインインが早い）
        delete c.accessToken
        delete c.refreshToken
        save()
        throw new AiError(t('ChatGPT へのサインインが切れました。もう一度サインインしてください。'), 401, 'siwc_expired')
      }
      throw error
    }
  })
  refreshing = run.catch(() => undefined)
  return run
}

export async function signOut(): Promise<void> {
  const c = load()
  if (c.refreshToken && c.clientId) {
    try {
      const discovery = (await (await fetch(`${AUTH}/.well-known/openid-configuration`)).json()) as { revocation_endpoint?: string }
      if (discovery.revocation_endpoint) await fetch(discovery.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: c.refreshToken, token_type_hint: 'refresh_token', client_id: c.clientId }) })
    } catch {
      // 取り消しを知らせられなくても、この PC のトークンは消す
    }
  }
  cred = { hostId: c.hostId, clientId: c.clientId, idToken: c.idToken }
  save()
}

/** サインインした人が、いま選べるモデル */
export async function siwcModels(): Promise<{ slug: string; name: string }[]> {
  if (!siwcState().signedIn) return []
  const response = await fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${await accessToken()}` } })
  if (!response.ok) return []
  const body = (await response.json()) as { models?: Record<string, string>[]; data?: Record<string, string>[] }
  return (body.models ?? body.data ?? []).filter((m) => (m['visibility'] ?? 'list') === 'list').map((m) => ({ slug: m['slug'] ?? m['id'], name: m['display_name'] ?? m['slug'] ?? m['id'] }))
}

/** サインインした人の ChatGPT のプランの枠で、AI に 1 回問い合わせる */
export async function siwcCall(call: AiCall, onDelta?: (full: string) => void): Promise<AiResult> {
  const token = await accessToken()
  if (!siwcState().planUsage) throw new AiError(t('この ChatGPT のアカウントでは、プランの枠をアプリで使う許可が出ていません。'), 403, 'siwc_scope')
  return callProvider({ openai: { token, planUsage: true } }, { ...call, family: 'openai', model: call.model || OPENAI_DEFAULT }, onDelta)
}
