/**
 * 本体側（Web 版）の入口。中身は core.ts にあり、ここは「読みこんで、届いたメッセージを渡す」だけにする。
 *
 * ★ このファイルには、import 文（先に読みこむ指定）を書かない。ほかのファイルからも、このファイルを読みこまない。
 *    Safari 26（iPhone・iPad をふくむ）には、ワーカーの入口のファイルを、ワーカーの中のほかのファイルが読みこむと、
 *    入口がもう一度はじめから動いてしまう不具合がある（WebKit の不具合 324459。2026 年 10 月に修正されたが、Safari 26 には入っていない）。
 *    入口に共通の部品を置くと、分けて読みこむファイル（handlers）が入口を読みこむ形になり、メッセージの受け口が
 *    「起動していないほう」に入れかわって、画面からの要求がすべて捨てられる（iPhone で、画面が 1 つも開かなかった原因）。
 *    できあがったファイルがこの形になっていないかは、vite.web.config.ts の検査（workerEntryGuard）が、作るたびに確かめる。
 */
const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent<unknown>) => void) | null }

const core = import('./core')
core.catch((error: unknown) => scope.postMessage({ type: 'fatal', error: `本体側を読みこめませんでした: ${error instanceof Error ? error.message : String(error)}` }))

// 中身を読みこむ前に届いたメッセージも、届いた順に渡す
scope.onmessage = (event) => void core.then((loaded) => loaded.receive(event.data as import('./core').Incoming), () => undefined)
