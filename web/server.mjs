// 学びアイ Web 版（PWA・試作）の、付属のサーバー。
//
//   node web/server.mjs [--port 5273] [--lan]
//
// 役目は 3 つ。
//   1. アプリの本体（dist-web/）と教材（同梱の資料 = /res/、授業・単元表・訳・画像 = /data/）を配る。教材は読むだけ（書きこまない）。
//      利用者のデータ（ノート・成績・設定）は、サーバーには置かない（各自のブラウザの中に残る）。
//   2. AI の取りつぎ（POST /api/ai）。つなぎ方は 3 つ。
//        cli  … 開発用。この PC の claude / codex のコマンドを動かす（自分のプランの使用量を使う）
//        key  … 運営者の API キー（環境変数 ANTHROPIC_API_KEY・OPENAI_API_KEY）で API を呼ぶ。
//               仕事ごとにモデルを割り当て（src/web/ai/routing.ts）、利用者ごとに 1 日の上限（MANABI_DAILY_CAP_USD。既定 0.5 ドル）をかける
//        siwc … Sign in with ChatGPT。サインインした人の ChatGPT のプランの枠で、OpenAI の Responses API を呼ぶ
//      （「利用者が自分の API キーを入れる」方式は、ブラウザから直接 API を呼ぶので、このサーバーを通らない）
//   3. Sign in with ChatGPT のサインイン（/api/siwc/…）。OpenAI の決まりどおり、http://127.0.0.1:1455/auth/callback で受ける。
//      トークンは、この PC のファイル（%APPDATA%\学びアイ\siwc\credentials.json）に置き、ブラウザには渡さない。
//
// ふつうは、この PC の中（127.0.0.1）からしか開けない。--lan を付けると、同じネットワークのタブレットなどからも開ける
// （そのときは、起動時に表示される合言葉つきの URL で開く）。
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { OPENAI_DEFAULT, callProvider } from '../src/web/ai/providers.ts'
import { routed } from '../src/web/ai/routing.ts'
import { findSnippets, searchPattern } from '../src/shared/search.ts'
import { cliStatus, runClaude, runCodex, setupCli } from './cli.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : fallback
}
const root = resolve(import.meta.dirname, '..')
const distDir = process.env['MANABI_DIST_DIR'] ? resolve(process.env['MANABI_DIST_DIR']) : join(root, 'dist-web')
const resDir = join(root, 'resources')
const appData = join(process.env['APPDATA'] ?? '', '学びアイ')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(appData, 'data')
const stateDir = process.env['MANABI_WEB_STATE_DIR'] ?? join(appData, 'web-server')
const siwcDir = process.env['MANABI_SIWC_DIR'] ?? join(appData, 'siwc')
const workDir = join(stateDir, 'ai-workdir')
const tempDir = join(stateDir, 'ai-temp')
for (const dir of [stateDir, siwcDir]) mkdirSync(dir, { recursive: true })
setupCli({ workDir, tempDir })
const PORT = Number(opt('port', process.env['PORT'] ?? 5273))
const LAN = args.includes('--lan')
const PASS = LAN ? String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0') : ''
const DAILY_CAP = Number(process.env['MANABI_DAILY_CAP_USD'] ?? 0.5)
const TOTAL_CAP = Number(process.env['MANABI_TOTAL_DAILY_CAP_USD'] ?? 20)
const log = (text) => console.log(`${new Date().toLocaleTimeString('ja-JP', { hour12: false })} ${text}`)

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (file, value) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 1), { encoding: 'utf8', mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

// ───────── ファイルを配る ─────────

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gz': 'application/gzip',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
}
/** 利用者のデータ置き場のうち、教材として配ってよいもの（ノートや成績は配らない） */
const DATA_DIRS = ['lessons', 'curricula', 'i18n', 'media', 'annot', 'essay']
const DATA_FILES = ['lessons-index.json']

function safeJoin(base, rest) {
  const parts = rest.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
  if (parts.some((part) => part === '..' || part.includes('\\') || part.includes(':') || part.endsWith('.tmp'))) return null
  const full = join(base, ...parts)
  return full.startsWith(base) ? full : null
}

const listings = new Map()
function listing(dir) {
  const cached = listings.get(dir)
  if (cached && Date.now() - cached.at < 30_000) return cached.body
  const out = {}
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.endsWith('.tmp')) continue
    if (entry.isDirectory()) out[entry.name] = 0
    else {
      const stat = statSync(join(dir, entry.name))
      out[entry.name] = [stat.size, Math.round(stat.mtimeMs)]
    }
  }
  const body = JSON.stringify(out)
  listings.set(dir, { at: Date.now(), body })
  return body
}

function sendFile(req, res, file, wantsList) {
  if (!file || !existsSync(file)) return send(res, 404, { error: '見つかりません' })
  const stat = statSync(file)
  if (stat.isDirectory()) {
    if (!wantsList) return send(res, 404, { error: '見つかりません' })
    res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-cache' })
    return res.end(listing(file))
  }
  const since = Date.parse(req.headers['if-modified-since'] ?? '')
  const modified = new Date(Math.floor(stat.mtimeMs / 1000) * 1000)
  if (since && since >= modified.getTime()) {
    res.writeHead(304)
    return res.end()
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': stat.size, 'Last-Modified': modified.toUTCString(), 'Cache-Control': 'no-cache' })
  res.end(readFileSync(file))
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((done, fail) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        fail(new Error('送られたデータが大きすぎます'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        fail(new Error('送られたデータを読み取れません'))
      }
    })
    req.on('error', fail)
  })
}

// ───────── 運営者の API キー: 利用者ごとの上限 ─────────

const ledgerFile = join(stateDir, 'usage.json')
const ledger = readJson(ledgerFile, {})
const today = () => new Date().toLocaleDateString('sv-SE')
const spentBy = (userId) => ledger[today()]?.[userId]?.cost ?? 0
const spentTotal = () => Object.values(ledger[today()] ?? {}).reduce((sum, row) => sum + row.cost, 0)
function charge(userId, task, result) {
  const day = (ledger[today()] ??= {})
  const row = (day[userId] ??= { cost: 0, calls: 0, tasks: {} })
  row.cost += result.cost ?? 0
  row.calls += 1
  row.tasks[task] = (row.tasks[task] ?? 0) + 1
  // 古い日の記録は 60 日ぶんだけ残す
  for (const key of Object.keys(ledger).sort().slice(0, -60)) delete ledger[key]
  writeJson(ledgerFile, ledger)
}

// ───────── Sign in with ChatGPT ─────────

const AUTH = 'https://auth.openai.com'
const AUTHORIZE = `${AUTH}/api/accounts/authorize`
const TOKEN = `${AUTH}/api/accounts/oauth/token`
const RESOURCE = 'https://api.openai.com/v1'
const REDIRECT = 'http://127.0.0.1:1455/auth/callback'
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const credFile = join(siwcDir, 'credentials.json')
/** { hostId, clientId, accessToken, refreshToken, idToken, expiresAt, scope, email, sub } */
let cred = readJson(credFile, {})
const saveCred = () => writeJson(credFile, cred)
const b64url = (buffer) => Buffer.from(buffer).toString('base64url')
const signedIn = () => !!cred.accessToken && !!cred.refreshToken
const planUsage = () => String(cred.scope ?? '').split(/\s+/).includes('chatgpt.tokens.use.direct')

/** ID トークンを確かめる（OpenAI の公開鍵で署名を確かめ、発行者・あて先・期限・1 回きりの値を見る） */
async function verifyIdToken(idToken, clientId, nonce) {
  const [head, body, signature] = idToken.split('.')
  const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'))
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  const jwks = await (await fetch(`${AUTH}/.well-known/jwks.json`)).json()
  const jwk = jwks.keys.find((key) => key.kid === header.kid)
  if (!jwk || header.alg !== 'RS256') throw new Error('ID トークンの署名の鍵が見つかりません')
  if (!verify('RSA-SHA256', Buffer.from(`${head}.${body}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'))) throw new Error('ID トークンの署名が正しくありません')
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (claims.iss !== AUTH || !audience.includes(clientId) || claims.exp * 1000 < Date.now() || (nonce && claims.nonce !== nonce)) throw new Error('ID トークンの中身が正しくありません')
  return claims
}

async function tokenRequest(fields) {
  const response = await fetch(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(fields) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(`トークンを受けとれませんでした（${response.status}・${body.error ?? ''}）`), { code: String(body.error ?? '') })
  return body
}

function storeTokens(body) {
  cred.accessToken = body.access_token
  if (body.refresh_token) cred.refreshToken = body.refresh_token
  if (body.id_token) cred.idToken = body.id_token
  cred.expiresAt = Date.now() + (Number(body.expires_in) || 3600) * 1000
  if (body.scope) cred.scope = body.scope
  saveCred()
}

/** サインインの途中の状態（1 回につき 1 つ） */
let pending = null
let callbackServer = null
function stopCallbackServer() {
  callbackServer?.close()
  callbackServer = null
}

function startSignIn() {
  cred.hostId ??= `urn:uuid:${randomUUID()}`
  saveCred()
  const verifier = b64url(randomBytes(32))
  pending = { state: b64url(randomBytes(16)), nonce: b64url(randomBytes(16)), verifier, at: Date.now() }
  const params = new URLSearchParams({
    // はじめてのときは、登録の入口（dynamic_agent_client）。2 回めからは、発行された client_id を使う
    client_id: cred.clientId ?? 'dynamic_agent_client',
    ext_agent_host_id: cred.hostId,
    response_type: 'code',
    redirect_uri: REDIRECT,
    scope: SCOPE,
    resource: RESOURCE,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  })
  if (!cred.clientId) params.set('agent_name_hint', 'Manabi AI')
  else if (cred.idToken) params.set('id_token_hint', cred.idToken)

  stopCallbackServer()
  const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:48px;line-height:1.8"><h1 style="font-size:1.3rem">${title}</h1><p>${text}</p>`
  callbackServer = createServer((req, res) => {
    const url = new URL(req.url, REDIRECT)
    if (url.pathname !== '/auth/callback') return res.writeHead(404).end()
    const finish = (title, text) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page(title, text))
      pending = null
      setTimeout(stopCallbackServer, 500)
    }
    void (async () => {
      try {
        if (!pending || url.searchParams.get('state') !== pending.state) return finish('サインインできませんでした', 'サインインの手続きが、このアプリから始めたものと合いません。学びアイにもどって、もう一度お試しください。')
        if (url.searchParams.get('error')) return finish('サインインをやめました', '許可されなかったので、サインインしていません。このタブを閉じて、学びアイにもどってください。')
        const issued = url.searchParams.get('client_id')
        // 2 回めからのサインインで、ちがう client_id が返ってきたら受けつけない
        if (cred.clientId && issued && issued !== cred.clientId) return finish('サインインできませんでした', '登録の情報が、前のサインインと合いません。')
        const clientId = cred.clientId ?? issued
        if (!clientId) return finish('サインインできませんでした', 'アプリの登録が終わっていません。もう一度お試しください。')
        const body = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code: url.searchParams.get('code') ?? '', code_verifier: pending.verifier, redirect_uri: REDIRECT, resource: RESOURCE })
        const claims = await verifyIdToken(body.id_token, clientId, pending.nonce)
        cred.clientId = clientId
        cred.sub = claims.sub
        cred.email = claims.email ?? ''
        storeTokens(body)
        log(`Sign in with ChatGPT: サインインしました（プランの枠の利用: ${planUsage() ? '許可あり' : '許可なし'}）`)
        finish('サインインできました', 'このタブを閉じて、学びアイにもどってください。')
      } catch (error) {
        log(`Sign in with ChatGPT: 失敗 ${error.message}`)
        finish('サインインできませんでした', String(error.message).replace(/[<>&]/g, ''))
      }
    })()
  })
  return new Promise((done, fail) => {
    callbackServer.once('error', (error) => fail(new Error(`サインインの受け口（127.0.0.1:1455）を開けませんでした: ${error.message}`)))
    callbackServer.listen(1455, '127.0.0.1', () => {
      // 10 分たっても終わらなければ、受け口を閉じる
      setTimeout(() => pending && Date.now() - pending.at >= 10 * 60_000 && stopCallbackServer(), 10 * 60_000 + 1000).unref()
      done(`${AUTHORIZE}?${params}`)
    })
  })
}

/** 使えるアクセストークンを返す（期限が近ければ、取りかえる。取りかえは、1 つずつ順に行う） */
let refreshing = Promise.resolve()
function accessToken() {
  const run = refreshing.then(async () => {
    if (!signedIn()) throw Object.assign(new Error('ChatGPT にサインインしていません。「AI のつなぎ方」からサインインしてください。'), { status: 401 })
    if (cred.expiresAt - Date.now() > 5 * 60_000) return cred.accessToken
    try {
      storeTokens(await tokenRequest({ grant_type: 'refresh_token', client_id: cred.clientId, refresh_token: cred.refreshToken, resource: RESOURCE }))
      return cred.accessToken
    } catch (error) {
      if (/invalid_grant|invalid_refresh_token|token_expired|refresh_token/.test(error.code ?? '')) {
        // 期限切れや取り消し。トークンだけを捨てる（登録の情報は残すので、次のサインインが早い）
        delete cred.accessToken
        delete cred.refreshToken
        saveCred()
        throw Object.assign(new Error('ChatGPT へのサインインが切れました。もう一度サインインしてください。'), { status: 401 })
      }
      throw error
    }
  })
  refreshing = run.catch(() => undefined)
  return run
}

async function signOut() {
  if (cred.refreshToken && cred.clientId) {
    try {
      const discovery = await (await fetch(`${AUTH}/.well-known/openid-configuration`)).json()
      if (discovery.revocation_endpoint) await fetch(discovery.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: cred.refreshToken, token_type_hint: 'refresh_token', client_id: cred.clientId }) })
    } catch {
      // 取り消しを知らせられなくても、この PC のトークンは消す
    }
  }
  cred = { hostId: cred.hostId, clientId: cred.clientId, idToken: cred.idToken }
  saveCred()
}

async function siwcModels() {
  const response = await fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${await accessToken()}` } })
  if (!response.ok) return []
  const body = await response.json()
  return (body.models ?? body.data ?? []).filter((m) => (m.visibility ?? 'list') === 'list').map((m) => ({ slug: m.slug ?? m.id, name: m.display_name ?? m.slug ?? m.id }))
}

// ───────── AI の取りつぎ ─────────

async function handleAi(req, res) {
  const body = await readBody(req)
  const { route, provider, system, turns, jsonSchema, task = 'other', userId = 'unknown' } = body
  if (!Array.isArray(turns) || !turns.length || typeof system !== 'string') return send(res, 400, { error: '問い合わせの形が正しくありません。' })
  const family = provider === 'claude' ? 'claude' : 'openai'

  // 始める前に分かる失敗は、ふつうの返事で知らせる
  if (route === 'key') {
    if (!(family === 'claude' ? process.env['ANTHROPIC_API_KEY'] : process.env['OPENAI_API_KEY'])) return send(res, 503, { error: `サーバーに、${family === 'claude' ? 'Claude' : 'OpenAI'} の API キーが設定されていません。` })
    if (spentBy(userId) >= DAILY_CAP) return send(res, 429, { error: 'きょう使える AI の量を使い切りました。あしたになると、また使えます。' })
    if (spentTotal() >= TOTAL_CAP) return send(res, 429, { error: 'きょうは、AI を使える量の全体の上限に達しました。あしたになると、また使えます。' })
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
  const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
  // 途中経過は、少し間をあけて送る
  let last = 0
  const onDelta = (full) => {
    if (Date.now() - last < 90) return
    last = Date.now()
    emit({ delta: full })
  }
  try {
    let result
    if (route === 'cli') {
      result = await (family === 'claude' ? runClaude({ model: body.model, effort: body.effort, system, turns, jsonSchema }, onDelta) : runCodex({ model: body.model, effort: body.effort, system, turns, jsonSchema }))
    } else if (route === 'key') {
      // どのモデルに頼むかは、サーバーが仕事の種類から決める（利用者が高いモデルを選ぶことはできない）
      const choice = routed(task, family)
      result = await callProvider({ anthropicKey: process.env['ANTHROPIC_API_KEY'], openai: { token: process.env['OPENAI_API_KEY'] ?? '' } }, { family, model: choice.model, effort: choice.effort, system, turns, jsonSchema: jsonSchema ?? undefined }, onDelta)
      charge(userId, task, result)
    } else if (route === 'siwc') {
      if (family === 'claude') throw new Error('Sign in with ChatGPT で使えるのは、OpenAI の側だけです。')
      if (!planUsage()) throw Object.assign(new Error('この ChatGPT のアカウントでは、プランの枠をアプリで使う許可が出ていません。'), { status: 403 })
      result = await callProvider({ openai: { token: await accessToken(), planUsage: true } }, { family: 'openai', model: body.model || OPENAI_DEFAULT, effort: body.effort || 'medium', system, turns, jsonSchema: jsonSchema ?? undefined }, onDelta)
    } else throw new Error('つなぎ方の指定が正しくありません。')
    emit({ delta: result.text })
    emit({ done: result })
    log(`AI ${route}/${family} ${task}: ${result.model}、入力 ${result.usage.input}・出力 ${result.usage.output}${result.cost !== null ? `、$${result.cost.toFixed(4)}` : ''}`)
  } catch (error) {
    log(`AI ${route}/${family} ${task}: 失敗 ${String(error.message).slice(0, 200)}`)
    emit({ error: String(error.message), status: error.status ?? 500 })
  }
  res.end()
}

// ───────── 受け口 ─────────

// ───────── 教科書を探す ─────────
// ブラウザの側は、授業を 1 つずつしか取り寄せられないので、探すのはサーバーの側で行う。
// 返すのは、保存名・出てくる回数・前後の文だけ（授業の名前は、ブラウザの側で引く）。

/** 科目 → 学校（同梱の科目表から） */
let courseSchools = null
function schoolOfCourse(courseId) {
  courseSchools ??= Object.fromEntries(readJson(join(resDir, 'content', 'catalog.json'), { courses: [] }).courses.map((c) => [c.id, c.school]))
  return courseSchools[courseId] ?? ''
}
async function searchLessons(query) {
  const pattern = searchPattern(String(query?.query ?? '').slice(0, 60))
  if (!pattern) return { total: 0, hits: [] }
  const schools = Array.isArray(query.schools) && query.schools.length ? new Set(query.schools.map(String)) : null
  const courseOf = (key) => key.replace(/\.deep$/, '').replace(/-\d+-\d+$/, '')
  const wanted = (key) => (query.courseId ? courseOf(key) === query.courseId : !schools || schools.has(schoolOfCourse(courseOf(key))))
  const files = []
  const seen = new Set()
  // 同梱の授業（人が書いたもの）を先に。同じ授業が両方にあれば、同梱のものを使う
  const shippedRoot = join(resDir, 'content')
  for (const entry of readdirSync(shippedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const name of readdirSync(join(shippedRoot, entry.name))) {
      if (!/^[A-Za-z0-9_-]+-\d+-\d+\.md$/.test(name)) continue
      const key = name.slice(0, -3)
      seen.add(key)
      if (wanted(key)) files.push({ key, file: join(shippedRoot, entry.name, name) })
    }
  }
  const lessonsDir = join(dataDir, 'lessons')
  for (const name of existsSync(lessonsDir) ? readdirSync(lessonsDir) : []) {
    if (!name.endsWith('.md')) continue
    const key = name.slice(0, -3)
    if (!seen.has(key) && wanted(key)) files.push({ key, file: join(lessonsDir, name) })
  }
  const hits = []
  for (let at = 0; at < files.length; at += 64) {
    const bodies = await Promise.all(files.slice(at, at + 64).map(({ file }) => readFile(file, 'utf8').catch(() => '')))
    bodies.forEach((body, i) => {
      const { count, snippets } = findSnippets(body, pattern, 2)
      if (count) hits.push({ key: files[at + i].key, count, snippets })
    })
  }
  hits.sort((a, b) => b.count - a.count)
  return { total: hits.length, hits: hits.slice(0, 400) }
}

const cookiePass = (req) => /(?:^|;\s*)manabi_pass=(\d{6})/.exec(req.headers.cookie ?? '')?.[1]

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
      const path = url.pathname.replace(/^\/+/, '')
      // --lan のとき: 合言葉つきの URL で 1 回開くと、その端末を覚える
      if (LAN) {
        if (url.searchParams.get('pass') === PASS) {
          res.writeHead(302, { 'Set-Cookie': `manabi_pass=${PASS}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`, Location: url.pathname })
          return res.end()
        }
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
        if (!local && cookiePass(req) !== PASS) return send(res, 401, { error: '合言葉つきの URL で開いてください。' })
      }

      if (path === 'api/status') {
        const { claude, codex } = await cliStatus()
        return send(res, 200, { claude, codex, keys: { claude: !!process.env['ANTHROPIC_API_KEY'], openai: !!process.env['OPENAI_API_KEY'] }, siwc: signedIn(), ...(signedIn() ? { siwcInfo: { email: cred.email ?? '', planUsage: planUsage(), expiresAt: cred.expiresAt } } : {}), cap: { dailyUsd: DAILY_CAP } })
      }
      if (path === 'api/search' && req.method === 'POST') return send(res, 200, await searchLessons(await readBody(req, 64 * 1024)))
      if (path === 'api/ai' && req.method === 'POST') return await handleAi(req, res)
      if (path === 'api/siwc/start' && req.method === 'POST') return send(res, 200, { url: await startSignIn() })
      if (path === 'api/siwc/signout' && req.method === 'POST') return send(res, 200, { ok: (await signOut(), true) })
      if (path === 'api/siwc/models') return send(res, 200, signedIn() ? await siwcModels() : [])
      if (path.startsWith('api/')) return send(res, 404, { error: '見つかりません' })

      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'この方法では受けつけません' })
      const list = url.searchParams.has('list')
      if (path === 'res' || path.startsWith('res/')) return sendFile(req, res, safeJoin(resDir, path.slice(4)), list)
      if (path.startsWith('data/')) {
        const rest = path.slice(5)
        const first = rest.split('/')[0]
        if (!DATA_DIRS.includes(first) && !DATA_FILES.includes(rest)) return send(res, 404, { error: '見つかりません' })
        return sendFile(req, res, safeJoin(dataDir, rest), list)
      }
      return sendFile(req, res, safeJoin(distDir, path || 'index.html'), false)
    } catch (error) {
      if (!res.headersSent) send(res, error.status ?? 500, { error: String(error.message) })
      else res.end()
    }
  })()
})

if (!existsSync(join(distDir, 'index.html'))) {
  console.error('dist-web/ がありません。先に npm run web:build を実行してください。')
  process.exit(1)
}
server.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  log(`学びアイ Web 版（試作）: http://127.0.0.1:${PORT}/`)
  if (LAN) {
    const addresses = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address)
    for (const address of addresses) log(`同じネットワークの端末からは: http://${address}:${PORT}/?pass=${PASS}`)
    log('（この URL を知っている人は、この PC の AI を使えます。信頼できるネットワークでだけ使ってください）')
  }
  log(`教材: ${dataDir}　／　API キー: Claude ${process.env['ANTHROPIC_API_KEY'] ? 'あり' : 'なし'}・OpenAI ${process.env['OPENAI_API_KEY'] ? 'あり' : 'なし'}　／　Sign in with ChatGPT: ${signedIn() ? 'サインイン中' : '未サインイン'}`)
})
