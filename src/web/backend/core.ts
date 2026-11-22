/**
 * 本体側（Web 版）の中身。Electron 版のメインプロセスにあたるものを、ブラウザのワーカーの中で動かす。
 *
 * 入口（worker.ts）から読みこまれ、親のページ（src/web/shell.tsx）とメッセージでやりとりする。
 *   ページ → ここ: { type: 'init', base } / { type: 'invoke', id, ctx, channel, args } / { type: 'active', view, params, idle }
 *   ここ → ページ: { type: 'ready', lang } / { type: 'result', id, ok, value | error } / { type: 'event', channel, payload, to? } / { type: 'shell', op, … }
 */
import { installGlobals } from '../shims/buffer'
import { flushFs, initFs } from '../shims/fs'
import { setBase } from '../ai/transport'

installGlobals()

export type Incoming =
  | { type: 'init'; base: string }
  | { type: 'invoke'; id: number; ctx: import('./handlers').Ctx; channel: string; args: unknown[] }
  | { type: 'active'; view: import('@shared/types').ViewName | null; params: import('@shared/types').ViewParams; idle: number }
  | { type: 'flush' }

const scope = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void }
let backend: typeof import('./handlers') | null = null
/** 起動が終わるまでに届いた要求は、捨てずに待たせておく */
let starting: Promise<void> | null = null

async function start(base: string): Promise<void> {
  try {
    await initFs({ base })
    setBase(base)
    // 本体側の部品は、読みこんだ時点で設定のファイルを読む。保存してあるデータを読み終えてから読みこむ
    backend = await import('./handlers')
    const lang = await backend.start({ base })
    scope.postMessage({ type: 'ready', lang })
  } catch (error) {
    scope.postMessage({ type: 'fatal', error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) })
  }
}

export function receive(message: Incoming): void {
  if (message.type === 'init') {
    starting ??= start(message.base)
    return
  }
  if (!backend) {
    // 起動の途中に届いた要求。起動が終わってから、あらためて受ける（起動に失敗していたら、その旨を返す）
    if (message.type === 'invoke') {
      const { id } = message
      void (starting ?? Promise.resolve()).then(() => (backend ? receive(message) : scope.postMessage({ type: 'result', id, ok: false, error: '本体側が、まだ起動していません。' })))
    }
    return
  }
  if (message.type === 'active') return backend.noteActive(message.view, message.params, message.idle)
  if (message.type === 'flush') return void flushFs()
  if (message.type === 'invoke') {
    const { id } = message
    void (async () => {
      try {
        const value = await backend!.invoke(message.ctx, message.channel, message.args)
        scope.postMessage({ type: 'result', id, ok: true, value })
      } catch (error) {
        scope.postMessage({ type: 'result', id, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })()
  }
}
