/**
 * Web 版で使えない Node の部品（child_process・zlib・readline・os・net・events）の代わり。
 * 外のコマンドは動かせないので、spawn は「起動できない」と答える（AI は、Web 版では通信で呼ぶ。src/web/ai/）。
 */
import { ungzip } from 'pako'
import { WebBuffer } from './buffer'

type Listener = (...args: unknown[]) => void

/** 起動できなかったコマンドの形だけを返す（'error' を 1 回知らせる） */
export function spawn(command: string, args: string[] = []) {
  const listeners = new Map<string, Listener[]>()
  const on = (event: string, listener: Listener) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener])
    return child
  }
  const stream = { on: () => stream, end: () => undefined, write: () => true }
  const child = { on, once: on, kill: () => true, exitCode: null as number | null, stdout: stream, stderr: stream, stdin: stream }
  // 「このコマンドは使えるか」（--version）の問いには、Web 版でその AI につなげるかどうかで答える
  const available = (globalThis as { __manabiAiAvailable?: (name: string) => boolean }).__manabiAiAvailable
  queueMicrotask(() => {
    if (args[0] === '--version' && available?.(command)) {
      child.exitCode = 0
      for (const listener of listeners.get('exit') ?? []) listener(0)
    } else for (const listener of listeners.get('error') ?? []) listener(new Error(`Web 版では、コマンド（${command}）を動かせません`))
  })
  return child
}

export function execFile(command: string, ..._rest: unknown[]): never {
  throw new Error(`Web 版では、コマンド（${command}）を動かせません`)
}

export const gunzipSync = (data: Uint8Array): WebBuffer => WebBuffer.wrap(ungzip(data))

export const createInterface = () => ({ on: () => undefined, close: () => undefined })
export const cpus = () => Array.from({ length: (globalThis.navigator?.hardwareConcurrency as number) || 4 }, () => ({}))
export const homedir = () => '/user'
export const createServer = (): never => {
  throw new Error('Web 版では、待ち受けは作れません')
}
export const once = (): Promise<never> => Promise.reject(new Error('Web 版では使えません'))

export default { spawn, execFile, gunzipSync, createInterface, cpus, homedir, createServer, once }
