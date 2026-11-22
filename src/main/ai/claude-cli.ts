import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { UsageWindow } from '@shared/types'
import { aiTempDir, aiWorkDir } from '../paths'
import { t } from '@shared/i18n'

/** claude CLI に渡すメッセージの中身（文章と画像） */
export type ClaudeContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } }

export interface ClaudeOptions {
  model: string
  effort: string
  system: string
  /** 指定すると、この JSON Schema に沿った結果を返す */
  jsonSchema?: object
}

// ───────── 使用量の通知 ─────────
//
// claude は応答のたびに、プランの使用量（5 時間あたり・1 週間あたりの使用割合と回復時刻）を知らせてくる。
// 授業の一括作成は、これを見て上限に近づいたら休む。

export interface RateLimit {
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  /** allowed 以外なら、すでに上限に達している */
  status: string
  at: number
}

let lastRateLimit: RateLimit | null = null

function recordRateLimit(info: any): void {
  const window = (w: any): UsageWindow | null =>
    w && typeof w.utilization === 'number' ? { utilization: w.utilization, resetsAt: Number(w.resetsAt) * 1000 } : null
  lastRateLimit = {
    fiveHour: window(info?.unifiedWindows?.five_hour),
    sevenDay: window(info?.unifiedWindows?.seven_day),
    status: String(info?.status ?? 'allowed'),
    at: Date.now(),
  }
}

export const getRateLimit = () => lastRateLimit

/** 休止が明けたら、古い値で再び休まないように忘れる（次の応答で新しい値が届く） */
export const clearRateLimit = () => {
  lastRateLimit = null
}

interface Turn {
  text: string
  onDelta?: (fullText: string) => void
  /** 返答の文章が出そろった時点で解決する */
  resolveMessage: (text: string) => void
  /** ターンが完全に終わった時点（構造化された結果つき）で解決する */
  resolveResult: (result: { text: string; structured: unknown }) => void
  reject: (error: Error) => void
  messageDone: boolean
}

/**
 * claude CLI を常駐させて会話する。
 *
 * 毎回起動すると 1 回あたり数秒の待ちが出るため、プロセスを立ち上げたままにして
 * 標準入力へ発言を 1 行ずつ送り、標準出力から返答を少しずつ受け取る。
 * ツール（コマンド実行やファイル操作）はすべて無効にしている。
 */
export class ClaudeSession {
  private child: ChildProcessWithoutNullStreams | null = null
  private turn: Turn | null = null
  private ready: Promise<void> = Promise.resolve()
  private stderr = ''
  private systemFile = ''
  private disposed = false

  constructor(private readonly options: ClaudeOptions) {}

  get alive(): boolean {
    return !this.disposed && (this.child === null || this.child.exitCode === null)
  }

  private async start(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && this.child.exitCode === null) return this.child
    // 指示文は長く、改行や引用符を含むので、コマンドライン引数ではなくファイルで渡す
    this.systemFile = join(aiTempDir(), `system-${randomUUID()}.txt`)
    await writeFile(this.systemFile, this.options.system, 'utf8')

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', this.options.model,
      '--effort', this.options.effort,
      '--system-prompt-file', this.systemFile,
      '--tools', '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--setting-sources', '',
    ]
    if (this.options.jsonSchema) args.push('--json-schema', JSON.stringify(this.options.jsonSchema))

    const child = spawn('claude', args, { cwd: aiWorkDir(), windowsHide: true })
    this.child = child
    this.stderr = ''
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-2000)
    })
    child.on('error', (error) => this.fail(new Error(t('claude を起動できませんでした: {0}', error.message))))
    child.on('exit', (code) => {
      void unlink(this.systemFile).catch(() => undefined)
      if (this.turn) this.fail(new Error(t('claude が途中で終了しました（コード {0}）。{1}', code, this.stderr.trim())))
    })
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line))
    return child
  }

  private fail(error: Error): void {
    const turn = this.turn
    this.turn = null
    turn?.reject(error)
  }

  private onLine(line: string): void {
    let event: any
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (event.type === 'rate_limit_event') recordRateLimit(event.rate_limit_info)
    const turn = this.turn
    if (!turn) return
    if (event.type === 'stream_event') {
      const inner = event.event
      if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
        turn.text += inner.delta.text
        turn.onDelta?.(turn.text)
      } else if (inner?.type === 'message_delta' && inner.delta?.stop_reason === 'end_turn' && !turn.messageDone) {
        turn.messageDone = true
        turn.resolveMessage(turn.text)
      }
    } else if (event.type === 'result') {
      this.turn = null
      if (event.is_error) {
        turn.reject(new Error(typeof event.result === 'string' && event.result ? event.result : t('AI からエラーが返りました。')))
        return
      }
      const text = turn.text || (typeof event.result === 'string' ? event.result : '')
      if (!turn.messageDone) turn.resolveMessage(text)
      turn.resolveResult({ text, structured: event.structured_output ?? null })
    }
  }

  private async begin(content: ClaudeContent[], onDelta?: (fullText: string) => void) {
    if (this.disposed) throw new Error(t('この会話はすでに閉じられています。'))
    // 前のターンの後片付け（result の受信）が終わってから次を送る
    await this.ready.catch(() => undefined)
    const child = await this.start()

    let resolveMessage!: (text: string) => void
    let resolveResult!: (result: { text: string; structured: unknown }) => void
    let rejectAll!: (error: Error) => void
    const message = new Promise<string>((res, rej) => {
      resolveMessage = res
      rejectAll = rej
    })
    const result = new Promise<{ text: string; structured: unknown }>((res, rej) => {
      resolveResult = res
      const prev = rejectAll
      rejectAll = (error) => {
        prev(error)
        rej(error)
      }
    })
    // どちらか片方しか待たれない場合に、未処理の拒否として扱われないようにする
    message.catch(() => undefined)
    result.catch(() => undefined)

    this.turn = { text: '', onDelta, resolveMessage, resolveResult, reject: rejectAll, messageDone: false }
    this.ready = result.then(() => undefined)
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n')
    return { message, result }
  }

  /** 発言を送り、返答の文章が出そろったら返す（文字は onDelta で少しずつ届く） */
  async send(content: ClaudeContent[], onDelta?: (fullText: string) => void): Promise<string> {
    const { message } = await this.begin(content, onDelta)
    return message
  }

  /** 発言を送り、ターンが完全に終わってから全文を返す */
  async sendAndWait(content: ClaudeContent[]): Promise<{ text: string; structured: unknown }> {
    const { result } = await this.begin(content)
    return result
  }

  /** 発言を送り、JSON Schema に沿った結果を返す */
  async sendStructured<T>(content: ClaudeContent[]): Promise<T> {
    const { text, structured } = await this.sendAndWait(content)
    if (structured) return structured as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(t('AI の返答を読み取れませんでした。もう一度お試しください。'))
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.fail(new Error(t('会話を閉じました。')))
    const child = this.child
    if (child && child.exitCode === null) {
      child.stdin.end()
      setTimeout(() => child.exitCode === null && child.kill(), 2000).unref()
    }
  }
}

/** 1 回だけ問い合わせて終わる用途（ノートの評価、授業の生成） */
export async function claudeOnce<T = string>(options: ClaudeOptions, content: ClaudeContent[]): Promise<T> {
  const session = new ClaudeSession(options)
  try {
    if (options.jsonSchema) return await session.sendStructured<T>(content)
    return (await session.sendAndWait(content)).text as T
  } finally {
    session.dispose()
  }
}
