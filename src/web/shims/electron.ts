/**
 * electron の代わり（Web 版）。
 *
 * - 画面側（iframe の中の各画面）: src/preload/index.ts をそのまま使うので、ipcRenderer と contextBridge を用意する。
 *   呼び出しは、親のページ（src/web/shell.tsx）が持つ橋（__manabiBridge）へ渡す。
 * - 本体側（ワーカーの中）: src/main の部品が読みこむ app・powerMonitor などを、形だけ用意する。
 */

// ───────── 画面側 ─────────

export interface ViewBridge {
  lang: string
  /** 教材づくりと、作り直しのボタンを出すか（開発用に作ったものだけ） */
  authoring: boolean
  invoke(channel: string, args: unknown[]): Promise<unknown>
  on(channel: string, listener: (payload: unknown) => void): void
  off(channel: string, listener: (payload: unknown) => void): void
}
const bridge = (): ViewBridge => {
  const found = (globalThis as { __manabiBridge?: ViewBridge }).__manabiBridge
  if (!found) throw new Error('画面と本体をつなぐ橋が、まだ用意されていません')
  return found
}

type IpcListener = (event: unknown, payload: any) => void
const wrapped = new Map<IpcListener, (payload: unknown) => void>()

export const ipcRenderer = {
  invoke: (channel: string, ...args: unknown[]): Promise<any> => bridge().invoke(channel, args),
  sendSync: (channel: string): unknown => (channel === 'i18n:lang' ? bridge().lang : channel === 'app:authoring' ? bridge().authoring : undefined),
  on(channel: string, listener: IpcListener) {
    const inner = (payload: unknown) => listener(null, payload)
    wrapped.set(listener, inner)
    bridge().on(channel, inner)
  },
  removeListener(channel: string, listener: IpcListener) {
    const inner = wrapped.get(listener)
    if (inner) bridge().off(channel, inner)
    wrapped.delete(listener)
  },
}

export const contextBridge = {
  exposeInMainWorld(name: string, api: unknown) {
    ;(globalThis as Record<string, unknown>)[name] = api
  },
}

// ───────── 本体側 ─────────

/** 画面から知らされた「最後に操作があってからの秒数」（学習時間を数えるのに使う） */
let idleSeconds = 0
export const setIdleSeconds = (seconds: number) => {
  idleSeconds = seconds
}

export const app = {
  getPath: (_name: string) => '/user',
  getAppPath: () => '/app',
  setPath: () => undefined,
  relaunch: () => undefined,
  quit: () => undefined,
  on: () => undefined,
  whenReady: () => Promise.resolve(),
  requestSingleInstanceLock: () => true,
  commandLine: { appendSwitch: () => undefined },
}
export const powerMonitor = { getSystemIdleTime: () => idleSeconds }
export const powerSaveBlocker = { start: () => 0, stop: () => undefined, isStarted: () => false }
export const shell = {
  openExternal: async (_url: string) => undefined,
  openPath: async (_path: string) => 'Web 版では、この PC のファイルを開けません',
  showItemInFolder: (_path: string) => undefined,
}
export const dialog = {
  showOpenDialog: async (..._args: unknown[]) => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async (..._args: unknown[]) => ({ canceled: true, filePath: '' }),
  showMessageBoxSync: (..._args: unknown[]) => 0,
}
export const nativeImage = { createFromPath: (_path: string) => ({ getSize: () => ({ width: 0, height: 0 }) }) }
export const net = { fetch: (input: string, init?: RequestInit) => fetch(input, init) }
export const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }), getAllDisplays: () => [] }
export const Menu = { setApplicationMenu: () => undefined }
export const ipcMain = { handle: () => undefined, on: () => undefined }
export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
  static getFocusedWindow(): BrowserWindow | null {
    return null
  }
  static fromWebContents(): BrowserWindow | null {
    return null
  }
}

export default { app, powerMonitor, powerSaveBlocker, shell, dialog, nativeImage, net, screen, Menu, ipcMain, BrowserWindow, ipcRenderer, contextBridge }
