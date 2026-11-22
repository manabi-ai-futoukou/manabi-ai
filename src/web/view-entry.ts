/**
 * 1 つの画面（教科書、ノートなど）の入口（Web 版）。親のページ（shell.tsx）の中の iframe で動く。
 *
 * Electron 版では、ウィンドウごとに preload（src/preload/index.ts）が window.manabi を用意する。
 * Web 版でも同じ preload をそのまま使い、electron の代わり（src/web/shims/electron.ts）が、呼び出しを親のページへ渡す。
 */
import type { ViewBridge } from './shims/electron'

interface Host {
  bridgeFor(key: string, frame: Window): ViewBridge
}
const host = (window.parent as unknown as { __manabiHost?: Host }).__manabiHost
const key = new URLSearchParams(location.search).get('key') ?? 'home'

if (!host || window.parent === window) {
  // 単独で開かれたときは、親のページへ移る
  location.replace('./')
} else {
  ;(globalThis as { __manabiBridge?: ViewBridge }).__manabiBridge = host.bridgeFor(key, window)
  // window.manabi を用意してから、画面の本体を読みこむ（画面の部品は、読みこんだ時点で window.manabi.lang を見る）
  await import('../preload/index')
  await import('../renderer/src/main')
}
