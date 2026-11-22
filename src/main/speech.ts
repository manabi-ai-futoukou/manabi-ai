import { app, net } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import type { SpeechModelId, SpeechStatus } from '@shared/types'
import { getSettings, setSettings } from './store'
import { t } from '@shared/i18n'

/**
 * 音声認識。マイクで録った声を、この PC の中だけで文字にする（音声を外へ送らない）。
 *
 * エンジンは whisper.cpp（OpenAI Whisper を C++ で動かすもの。MIT ライセンス）。
 * 大きなファイルなのでアプリには同梱せず、使う人が「準備する」を押したときに公式の配布元から取り寄せる。
 *
 *   エンジン本体 … GitHub の ggml-org/whisper.cpp のリリース（Windows 用のビルド、約 9MB）
 *   音声モデル   … Hugging Face の ggerganov/whisper.cpp（高精度 約 550MB ／ 軽量 約 180MB）
 *
 * 取り寄せたファイルは、あらかじめ控えておいた SHA-256 と照らし合わせて、書きかえられていないことを確かめる。
 * 文字にするときは、エンジンを小さなサーバーとして起動しておき（この PC の中からだけつながる）、録音を渡す。
 */

const ENGINE = {
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
  sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
}

const MODELS: Record<SpeechModelId, { file: string; sha256: string }> = {
  turbo: { file: 'ggml-large-v3-turbo-q5_0.bin', sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' },
  small: { file: 'ggml-small-q5_1.bin', sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb' },
}
const modelUrl = (id: SpeechModelId) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODELS[id].file}`

/** エンジンとモデルの置き場。ふだんのデータとは別にして、自動確認でも同じものを使い回せるようにする */
function speechDir(...sub: string[]): string {
  const dir = join(process.env['MANABI_SPEECH_DIR'] || join(app.getPath('userData'), 'speech'), ...sub)
  mkdirSync(dir, { recursive: true })
  return dir
}

const modelPath = (id: SpeechModelId) => join(speechDir('models'), MODELS[id].file)

/** 展開したエンジンの中から、サーバーの実行ファイルを探す（配布物のフォルダ構成が変わっても見つけられるように） */
function serverPath(): string | null {
  const search = (dir: string, depth: number): string | null => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (name.toLowerCase() === 'whisper-server.exe') return full
      if (depth > 0 && statSync(full).isDirectory()) {
        const found = search(full, depth - 1)
        if (found) return found
      }
    }
    return null
  }
  return search(speechDir('engine'), 2)
}

// ───────── 状態 ─────────

let progress: SpeechStatus['progress'] = null
let lastError: string | null = null
let notify: () => void = () => {}

export function onSpeechChanged(listener: () => void): void {
  notify = listener
}

const isModel = (value: unknown): value is SpeechModelId => value === 'turbo' || value === 'small'

export function speechStatus(): SpeechStatus {
  const installed = (Object.keys(MODELS) as SpeechModelId[]).filter((id) => existsSync(modelPath(id)))
  const wanted = getSettings().speechModel
  const model = installed.includes(wanted) ? wanted : (installed[0] ?? wanted)
  const engine = !!serverPath()
  return { ready: engine && installed.includes(model), engine, installed, model, progress, error: lastError }
}

// ───────── 準備（ダウンロード） ─────────

async function download(url: string, dest: string, sha256: string, label: string): Promise<void> {
  const response = await net.fetch(url)
  if (!response.ok || !response.body) throw new Error(t('{0}をダウンロードできませんでした（{1}）。', label, response.status))
  const total = Number(response.headers.get('content-length')) || 0
  const part = `${dest}.part`
  const out = createWriteStream(part)
  const hash = createHash('sha256')
  let received = 0
  let reported = 0
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      received += value.length
      if (!out.write(value)) await once(out, 'drain')
      // 画面への通知は、0.3 秒に 1 回まで
      if (Date.now() - reported > 300) {
        reported = Date.now()
        progress = { label, received, total }
        notify()
      }
    }
  } finally {
    await new Promise((resolve) => out.end(resolve))
  }
  if (hash.digest('hex') !== sha256) {
    rmSync(part, { force: true })
    throw new Error(t('{0}を正しく受け取れませんでした（内容の照合に失敗）。もう一度お試しください。', label))
  }
  renameSync(part, dest)
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error) => (error ? reject(error) : resolve()))
  })
}

let installing: Promise<void> | null = null

/** 音声認識を使えるようにする。足りないもの（エンジン本体、選んだモデル）だけを取り寄せる */
export function installSpeech(model: SpeechModelId): Promise<void> {
  if (!isModel(model)) throw new Error(t('モデルの指定が正しくありません。'))
  if (installing) return installing
  lastError = null
  installing = (async () => {
    if (!serverPath()) {
      const zip = join(speechDir(), 'whisper-bin-x64.zip')
      await download(ENGINE.url, zip, ENGINE.sha256, t('音声認識のエンジン'))
      progress = { label: t('エンジンを展開しています'), received: 0, total: 0 }
      notify()
      // Windows に入っている tar は zip も展開できる
      await run('tar.exe', ['-xf', zip, '-C', speechDir('engine')])
      rmSync(zip, { force: true })
      if (!serverPath()) throw new Error(t('エンジンを展開できませんでした。'))
    }
    if (!existsSync(modelPath(model))) await download(modelUrl(model), modelPath(model), MODELS[model].sha256, t('音声モデル'))
    setSettings({ speechModel: model })
  })()
    .catch((error: unknown) => {
      lastError = error instanceof Error ? error.message : String(error)
      throw error
    })
    .finally(() => {
      installing = null
      progress = null
      notify()
    })
  return installing
}

/** 使うモデルを切りかえる（すでに入っているものだけ） */
export function chooseSpeechModel(model: SpeechModelId): SpeechStatus {
  if (!isModel(model) || !existsSync(modelPath(model))) throw new Error(t('そのモデルは、まだ入っていません。'))
  setSettings({ speechModel: model })
  return speechStatus()
}

// ───────── 文字にする ─────────

interface Server {
  process: ChildProcess
  port: number
  model: SpeechModelId
}

let server: Server | null = null
let starting: Promise<Server> | null = null
let idleTimer: NodeJS.Timeout | null = null
const IDLE_MS = 10 * 60 * 1000

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error(t('空いているポートがありません。')))))
    })
  })
}

export function stopSpeechServer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  server?.process.kill()
  server = null
}

async function startServer(model: SpeechModelId): Promise<Server> {
  const exe = serverPath()
  if (!exe || !existsSync(modelPath(model))) throw new Error(t('音声認識の準備ができていません。'))
  const port = await freePort()
  const threads = Math.max(2, Math.min(16, Math.floor(cpus().length / 2)))
  // モデルは「フォルダへ移動してからファイル名だけで指定」する。
  // whisper.cpp は、日本語などをふくむパス（アプリ名の「学びアイ」）を引数で受け取ると、ファイルを開けないため
  const child = spawn(exe, ['-m', MODELS[model].file, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads), '-l', 'auto'], {
    cwd: dirname(modelPath(model)),
    windowsHide: true,
    stdio: 'ignore',
  })
  const started: Server = { process: child, port, model }
  child.once('exit', () => {
    if (server === started) server = null
  })
  // モデルの読みこみが終わって、応答するようになるまで待つ（長くて 1 分）
  const deadline = Date.now() + 60_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(t('音声認識のエンジンを起動できませんでした。'))
    const ok = await fetch(`http://127.0.0.1:${port}/`).then(
      (r) => r.ok,
      () => false,
    )
    if (ok) return started
    if (Date.now() > deadline) {
      child.kill()
      throw new Error(t('音声認識のエンジンが応答しません。'))
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function ensureServer(): Promise<Server> {
  const { ready, model } = speechStatus()
  if (!ready) throw new Error(t('音声認識の準備ができていません。ホームの「音声」から準備できます。'))
  if (server && server.model === model && server.process.exitCode === null) return server
  if (!starting) {
    stopSpeechServer()
    starting = startServer(model)
      .then((started) => (server = started))
      .finally(() => (starting = null))
  }
  return starting
}

/** 無音や雑音のときに、音声認識が作り出しがちな決まり文句（聞き取れなかったものとして扱う） */
const PHANTOMS = [/^ご視聴ありがとうございました[。.!！]?$/, /^(thank you|thanks for watching)[.!]?$/i, /^字幕.*$/, /^you$/i]

let queue: Promise<unknown> = Promise.resolve()

/**
 * 録音（16kHz・モノラルの WAV）を文字にする。
 * @param lang ja: 日本語 / en: 英語 / auto: どちらかを自動で判別
 */
export function transcribe(wav: Uint8Array, lang: 'ja' | 'en' | 'auto'): Promise<string> {
  if (wav.byteLength < 2000) return Promise.resolve('')
  if (wav.byteLength > 16000 * 2 * 150) throw new Error(t('録音が長すぎます。2 分以内で区切ってください。'))
  // 同時に頼まれても、1 つずつ順番に行う
  const task = queue.then(async () => {
    const { port } = await ensureServer()
    if (idleTimer) clearTimeout(idleTimer)
    const form = new FormData()
    form.append('file', new Blob([wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'speech.wav')
    form.append('language', lang === 'ja' || lang === 'en' ? lang : 'auto')
    form.append('response_format', 'json')
    form.append('temperature', '0.0')
    form.append('temperature_inc', '0.2')
    // 短い録音では、音声を読みこむ範囲（ふつうは 30 秒ぶん）をせばめて、数倍速く処理する
    const seconds = (wav.byteLength - 44) / (16000 * 2)
    if (seconds < 22) form.append('audio_ctx', String(Math.max(512, Math.ceil(seconds * 50) + 256)))
    const response = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form })
    idleTimer = setTimeout(stopSpeechServer, IDLE_MS)
    idleTimer.unref()
    if (!response.ok) throw new Error(t('音声を文字にできませんでした。もう一度お試しください。'))
    const body = (await response.json()) as { text?: string }
    const text = String(body.text ?? '')
      // 「[音楽]」「(拍手)」のような、声以外の説明を取り除く
      .replace(/\[[^\]]*\]|\([^)]*\)|（[^）]*）|♪/g, ' ')
      .replace(/\s+/g, ' ')
      // 日本語の文のあいだに入る空白は取り除く（英単語どうしの空白は残す）
      .replace(/([ぁ-んァ-ヶー一-龠々、。！？」』）])\s+(?=[ぁ-んァ-ヶー一-龠々「『（])/g, '$1')
      .trim()
    return PHANTOMS.some((pattern) => pattern.test(text)) ? '' : text
  })
  queue = task.catch(() => undefined)
  return task
}
