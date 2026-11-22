/**
 * 親のページ（Web 版）。Electron 版の「ウィンドウを開く・並べる」役目を、1 つのページの中で受けもつ。
 *
 * - 本体側（src/web/backend/worker.ts）をワーカーとして起動し、各画面（iframe）からの要求を取りつぐ
 * - 画面はタブとして開き、広い画面では 2 つ（漢字特訓は 3 つ）を並べて表示する（タブレットで、教科書とノートを並べる使い方）
 * - AI のつなぎ方（開発用・自分の API キー・運営者の API キー・Sign in with ChatGPT）を選ぶ
 */
import { StrictMode, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import type { ViewName, ViewParams } from '@shared/types'
import type { Route, UsageRow, WebAiConfig } from './ai/transport'
import { TASK_LABELS } from './ai/routing'
import type { ViewBridge } from './shims/electron'
import './shell.css'

const BASE = new URL('.', location.href).href
/** AI のつなぎ方のうち、この作りで使えるもの（vite.web.config.ts が埋めこむ。配る版は「自分の API キー」だけ） */
declare const __MANABI_WEB_ROUTES__: string[]
/** 開発用に作ったものか。配る版では、教材づくりと、掛け合い・動く図解の作り直しを出さない */
const AUTHORING = __MANABI_WEB_ROUTES__.length > 1

// ───────── 本体側（ワーカー）とのやりとり ─────────

interface OpenView {
  key: string
  view: ViewName
  params: ViewParams
}
interface State {
  ready: boolean
  fatal: string
  lang: string
  views: OpenView[]
  /** いま並べて見せている画面（1〜3 つ） */
  panes: string[]
  focus: string
  wide: boolean
  /** スマートフォン（はばのせまい画面）向けの表示か。タブを下に置き、画面は 1 つずつ見せる */
  phone: boolean
  /** スマートフォンで、メニュー（下のタブと、各画面の上の帯）を出しているか。はじめは、かくしておく（画面を広く使う） */
  bars: boolean
  /** 固定している画面（1 つまで）と、置く側。固定中は、ほかの画面を開いても閉じず、ほかの画面は反対側に開く */
  pin: Pin | null
}
type Side = 'left' | 'right'
interface Pin {
  key: string
  side: Side
}
/** メニューを出しているか（この端末に覚えておく。はじめは、かくす） */
function readBars(): boolean {
  try {
    return localStorage.getItem('manabi-bars') === 'shown'
  } catch {
    return false
  }
}
/** 各画面に、スマートフォン向けかどうかと、メニューを出しているかを知らせる（画面の側の見た目は、この目印で切りかわる） */
function markFrame(frame: Window): void {
  const root = frame.document?.documentElement
  if (!root) return
  root.toggleAttribute('data-phone', state.phone)
  if (state.phone) root.setAttribute('data-bars', state.bars ? 'shown' : 'hidden')
  else root.removeAttribute('data-bars')
}
function setBars(bars: boolean): void {
  setState({ bars })
  try {
    localStorage.setItem('manabi-bars', bars ? 'shown' : 'hidden')
  } catch {
    // 覚えられなくても、切りかえはできる
  }
  for (const frame of frames.values()) markFrame(frame)
}

/** スマートフォン向けにするか: はばが 600px より小さい。または、指で使う端末を横にしたとき（高さが 500px より小さい） */
const isPhone = () => window.innerWidth < 600 || (window.innerHeight < 500 && window.matchMedia('(pointer: coarse)').matches)
let state: State = { ready: false, fatal: '', lang: 'ja', views: [], panes: [], focus: '', wide: window.innerWidth >= 900 && !isPhone(), pin: null, phone: isPhone(), bars: readBars() }
const subscribers = new Set<() => void>()
const setState = (patch: Partial<State>) => {
  state = { ...state, ...patch }
  subscribers.forEach((fn) => fn())
}
const useShell = () => useSyncExternalStore((fn) => (subscribers.add(fn), () => subscribers.delete(fn)), () => state)

const worker = new Worker(new URL('./backend/worker.ts', import.meta.url), { type: 'module' })
let nextId = 1
const waiting = new Map<number, { channel: string; resolve: (value: any) => void; reject: (error: Error) => void }>()
const SHELL_CTX = { key: 'shell', view: 'home' as ViewName, params: {} }

function call<T = unknown>(channel: string, args: unknown[] = [], ctx: { key: string; view: ViewName; params: ViewParams } = SHELL_CTX): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++
    waiting.set(id, { channel, resolve, reject })
    worker.postMessage({ type: 'invoke', id, ctx, channel, args })
  })
}

type Listener = (payload: unknown) => void
const listeners = new Map<string, Map<string, Set<Listener>>>()
const frames = new Map<string, Window>()
function emit(channel: string, payload: unknown, to?: string): void {
  for (const [key, channels] of listeners) {
    if (to && to !== key) continue
    for (const listener of channels.get(channel) ?? []) {
      try {
        listener(payload)
      } catch {
        // 閉じた画面の聞き手は、そのまま捨てる
      }
    }
  }
}

worker.onmessage = (event: MessageEvent<any>) => {
  const message = event.data
  if (message.type === 'ready') {
    setState({ ready: true, lang: message.lang })
    document.documentElement.lang = message.lang
    void call<{ zoom: Record<string, number> }>('settings:get').then((settings) => Object.assign(zooms, settings.zoom), () => undefined)
    // 最初の画面を開けなかったときは、だまって白いままにせず、わけを出す
    call<ViewName>('web:start-view')
      .then((view) => openView(view, {}))
      .catch((error: unknown) => setState({ fatal: `最初の画面を開けませんでした: ${error instanceof Error ? error.message : String(error)}` }))
    setTimeout(() => {
      if (!state.views.length && !state.fatal) setState({ fatal: `本体側から返事がありません（20 秒待ちました）。ページを読みこみ直してみてください。\n${navigator.userAgent}` })
    }, 20_000)
  } else if (message.type === 'fatal') setState({ fatal: String(message.error) })
  else if (message.type === 'result') {
    const pending = waiting.get(message.id)
    waiting.delete(message.id)
    if (message.ok) pending?.resolve(message.value)
    else pending?.reject(new Error(pending.channel.startsWith('web:') ? String(message.error) : `Error invoking remote method '${pending.channel}': Error: ${message.error}`))
  } else if (message.type === 'event') emit(message.channel, message.payload, message.to)
  else if (message.type === 'shell') {
    if (message.op === 'open') void openView(message.view, message.params ?? {})
    else if (message.op === 'close') (message.views as ViewName[]).forEach((view) => state.views.filter((v) => v.view === view).forEach((v) => closeView(v.key)))
    else if (message.op === 'close-key') state.views.some((v) => v.key === message.key) && closeView(message.key)
    else if (message.op === 'close-except') closeExcept(message.keep)
    else if (message.op === 'reload') location.reload()
    else if (message.op === 'zoom') applyZoom(message.view, message.value)
  }
}
worker.onerror = (event) => setState({ fatal: `本体側を起動できませんでした: ${event.message}` })
worker.postMessage({ type: 'init', base: BASE })

// ───────── 画面を開く・並べる ─────────

const keyOf = (view: ViewName, params: ViewParams) => (view === 'note' ? `note:${params.notebookId ?? ''}` : view)
const KANJI: ViewName[] = ['kanji', 'kanjiOrder', 'kanjiNote']

/** 教科書といっしょに開いているノート（1 冊だけ） */
let companion: string | null = null

async function openView(view: ViewName, params: ViewParams, fromKey?: string): Promise<void> {
  // 教材づくりは、開発用に作ったものだけ
  if (view === 'library' && !AUTHORING) return
  const together = params.beside === 'left' || params.beside === 'right'
  // 教科書といっしょに開くノートは、2 つ並べられる広さのときだけ開く（せまい画面では、教科書がノートに隠れてしまう）
  if (together && !state.wide) return
  const prepared = await call<{ view: ViewName; params: ViewParams }>('web:prepare-open', [view, params])
  const key = keyOf(prepared.view, prepared.params)
  if (together) {
    // 授業を移ったら、前の授業のノートは閉じる（ノートのタブが、開いた授業の数だけ増えていかないように）
    if (companion && companion !== key && state.views.some((v) => v.key === companion)) {
      // 閉じる前に、書きかけを保存させる（ノートは、フォーカスが外れたときに保存する）
      try {
        const frame = frames.get(companion) as (Window & typeof globalThis) | undefined
        frame?.dispatchEvent(new frame.Event('blur'))
      } catch {
        // 保存の合図を送れなくても、閉じるのは続ける
      }
      closeView(companion)
    }
    companion = key
  }
  const existing = state.views.find((v) => v.key === key)
  let views = state.views
  if (existing) {
    views = views.map((v) => (v.key === key ? { ...v, params: prepared.params } : v))
    emit('view:params', prepared.params, key)
  } else views = [...views, { key, view: prepared.view, params: prepared.params }]
  const placed = place(key, prepared.view, fromKey, views)
  // 並べ方が変わって、固定している画面が見えなくなったら（漢字特訓の 3 つ並びなど）、固定は解く
  const unpinned = !!state.pin && state.wide && !placed.panes.includes(state.pin.key)
  setState({ views, ...placed, ...(unpinned ? { pin: null } : {}) })
  if (unpinned) announcePin()
  // 教科書といっしょに開くノートは、利き手の側に固定する（広い画面のときだけ。もう 1 つの画面 = 教科書は、反対側に残る）
  const beside = prepared.params.beside
  if ((beside === 'left' || beside === 'right') && state.wide) {
    setPin(key, beside)
    // 手前（操作している画面）は、教科書のままにする
    if (fromKey && state.panes.includes(fromKey)) setState({ focus: fromKey })
  }
}

/** 固定している画面と、もう 1 つの画面（無ければ、固定している画面だけ）を、決めた側に並べる */
const withPin = (pin: Pin, other: string | undefined): string[] => (!other || other === pin.key ? [pin.key] : pin.side === 'left' ? [pin.key, other] : [other, pin.key])

/** 固定が変わったことを、すべての画面に知らせる（画面の中の「固定」のボタンの表示を合わせる） */
const announcePin = () => emit('changed', 'pin')

/** 画面を固定する・固定をやめる（side が null なら、やめる） */
function setPin(key: string, side: Side | null): void {
  if (!side) {
    // 「固定をやめる」は、どの画面から頼まれても、いまの固定を解く
    if (state.pin) setState({ pin: null })
    return announcePin()
  }
  if (!state.wide || !state.views.some((v) => v.key === key)) return
  const pin = { key, side }
  // いま並んでいる、もう 1 つの画面は、反対側に残す
  const other = state.panes.find((k) => k !== key)
  setState({ pin, panes: withPin(pin, other), focus: key })
  announcePin()
}

/** 2 つ並べているときに、左右を入れかえる（固定している側も入れかわる） */
function swapPanes(): void {
  if (state.panes.length !== 2) return
  const pin = state.pin && { ...state.pin, side: state.pin.side === 'left' ? ('right' as const) : ('left' as const) }
  setState({ panes: [state.panes[1], state.panes[0]], pin })
  announcePin()
}

/** 開いた画面を、どこに見せるかを決める */
function place(key: string, view: ViewName, fromKey: string | undefined, views: OpenView[]): Pick<State, 'panes' | 'focus'> {
  const { panes, wide, pin } = state
  const open = (k: string) => views.some((v) => v.key === k)
  // 漢字特訓は、3 つの画面（漢字・書き順・ノート）を並べて使う
  if (wide && KANJI.includes(view) && KANJI.every((k) => open(k))) return { panes: [...KANJI], focus: key }
  // 固定している画面があるとき: その画面は動かさず、開いた画面を反対側に見せる
  if (wide && pin && open(pin.key)) return { panes: key === pin.key ? (panes.includes(key) ? panes : withPin(pin, panes.find((k) => k !== key))) : withPin(pin, key), focus: key }
  if (panes.includes(key)) return { panes, focus: key }
  const from = fromKey && panes.includes(fromKey) ? views.find((v) => v.key === fromKey) : undefined
  // ホーム以外の画面から開いたものは、広い画面なら、元の画面のとなりに並べる（教科書のとなりにノート、など）
  if (wide && from && from.view !== 'home') {
    if (panes.length === 1) return { panes: [panes[0], key], focus: key }
    const at = panes.findIndex((k) => k !== fromKey)
    return { panes: panes.map((k, i) => (i === at ? key : k)), focus: key }
  }
  const at = Math.max(0, panes.indexOf(fromKey && panes.includes(fromKey) ? fromKey : state.focus))
  return { panes: panes.length ? panes.map((k, i) => (i === at ? key : k)) : [key], focus: key }
}

function closeView(key: string): void {
  if (key === 'home' && state.views.length === 1) return
  const views = state.views.filter((v) => v.key !== key)
  listeners.delete(key)
  frames.delete(key)
  let panes = state.panes.filter((k) => k !== key)
  if (!panes.length) panes = [views.at(-1)?.key ?? 'home']
  // 固定している画面を閉じたら、固定は解く
  const unpinned = state.pin?.key === key
  setState({ views, panes, focus: panes.includes(state.focus) ? state.focus : panes[0], ...(unpinned ? { pin: null } : {}) })
  if (unpinned) announcePin()
  if (!views.length) void openView('home', {})
}

function closeExcept(keep: ViewName): void {
  for (const v of state.views) if (v.view !== keep) (listeners.delete(v.key), frames.delete(v.key))
  const views = state.views.filter((v) => v.view === keep)
  setState({ views, panes: views.map((v) => v.key).slice(0, 1), focus: views[0]?.key ?? '', pin: null })
  if (!views.length) void openView(keep, {})
}

function showTab(key: string): void {
  if (state.panes.includes(key)) return setState({ focus: key })
  if (state.wide && state.pin) return setState({ panes: withPin(state.pin, key), focus: key })
  const at = Math.max(0, state.panes.indexOf(state.focus))
  setState({ panes: state.panes.map((k, i) => (i === at ? key : k)), focus: key })
}

function setSplit(split: boolean): void {
  if (!split) return setState({ panes: [state.focus || state.panes[0]] })
  const other = [...state.views].reverse().find((v) => !state.panes.includes(v.key))
  if (other) setState({ panes: [state.panes[0], other.key] })
}

const zooms: Record<string, number> = {}
function applyZoom(view: ViewName, value: number): void {
  zooms[view] = value
  for (const v of state.views) if (v.view === view) frames.get(v.key)?.document.documentElement.style.setProperty('zoom', String(value))
}

// ───────── 各画面（iframe）からの要求 ─────────

async function pickImage(): Promise<unknown> {
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/gif,image/webp'
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.oncancel = () => resolve(null)
    input.click()
  })
  if (!file) return null
  const bitmap = await createImageBitmap(file).catch(() => null)
  return call('web:attachment-import', [{ name: file.name, bytes: await file.arrayBuffer(), width: bitmap?.width ?? 0, height: bitmap?.height ?? 0 }])
}

async function exportPdf(title: string, images: string[]): Promise<{ saved: boolean; path?: string }> {
  const bytes = await call<Uint8Array>('web:pdf', [title, images])
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}.pdf`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return { saved: true, path: link.download }
}

function invokeFromView(key: string, channel: string, args: unknown[]): Promise<unknown> {
  const self = state.views.find((v) => v.key === key)
  const ctx = { key, view: self?.view ?? 'home', params: self?.params ?? {} }
  switch (channel) {
    case 'view:get':
      return Promise.resolve({ view: ctx.view, params: ctx.params })
    case 'view:open':
      return openView(args[0] as ViewName, (args[1] as ViewParams) ?? {}, key)
    case 'view:pin':
      setPin(key, args[0] === 'left' || args[0] === 'right' ? args[0] : null)
      return Promise.resolve(state.pin?.key === key ? state.pin.side : null)
    case 'view:pinned':
      return Promise.resolve(state.wide && state.pin?.key === key ? state.pin.side : null)
    case 'view:context':
      setState({ views: state.views.map((v) => (v.key === key ? { ...v, params: { ...v.params, ...(args[0] as ViewParams) } } : v)) })
      return Promise.resolve()
    case 'attachments:pick-image':
      return pickImage()
    case 'attachments:open':
      if (args[0] === 'link' && /^https?:\/\//i.test(String(args[1]))) window.open(String(args[1]), '_blank', 'noopener')
      else return Promise.reject(new Error('Web 版では、この PC の中の動画ファイルは開けません。'))
      return Promise.resolve()
    case 'notes:export-pdf':
      return exportPdf(String(args[0]), args[1] as string[])
    default:
      return call(channel, args, ctx)
  }
}

let lastInput = Date.now()
const host = {
  bridgeFor(key: string, frame: Window): ViewBridge {
    frames.set(key, frame)
    const mine = new Map<string, Set<Listener>>()
    listeners.set(key, mine)
    // どの画面を操作しているか（並べたときの「手前」）と、最後に操作した時刻
    frame.addEventListener('pointerdown', () => ((lastInput = Date.now()), state.focus !== key && setState({ focus: key })), true)
    frame.addEventListener('keydown', () => (lastInput = Date.now()), true)
    const view = state.views.find((v) => v.key === key)?.view
    if (view && zooms[view]) frame.document.documentElement.style.setProperty('zoom', String(zooms[view]))
    markFrame(frame)
    return {
      lang: state.lang,
      authoring: AUTHORING,
      invoke: (channel, args) => invokeFromView(key, channel, args),
      on: (channel, listener) => void (mine.get(channel) ?? mine.set(channel, new Set()).get(channel)!).add(listener),
      off: (channel, listener) => void mine.get(channel)?.delete(listener),
    }
  },
}
;(window as unknown as { __manabiHost: typeof host }).__manabiHost = host

// 学習時間を数えるために、手前の画面と、操作が止まってからの秒数を本体側へ知らせる
setInterval(() => {
  const front = document.visibilityState === 'visible' ? state.views.find((v) => v.key === state.focus) : undefined
  worker.postMessage({ type: 'active', view: front?.view ?? null, params: front?.params ?? {}, idle: Math.round((Date.now() - lastInput) / 1000) })
}, 5000)
window.addEventListener('resize', () => {
  const phone = isPhone()
  if (phone !== state.phone) {
    setState({ phone })
    // 開いている画面にも、スマートフォン向けかどうかを知らせる
    for (const frame of frames.values()) markFrame(frame)
  }
  const wide = window.innerWidth >= 900 && !phone
  if (wide === state.wide) return
  // せまい画面では 1 つだけ見せる（固定は、広くなったときにもどる）
  const pin = state.pin
  setState({ wide, panes: !wide ? [state.focus || state.panes[0]].filter(Boolean) : pin ? withPin(pin, state.focus !== pin.key ? state.focus : undefined) : state.panes })
  announcePin()
})
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && worker.postMessage({ type: 'flush' }))

if ('serviceWorker' in navigator && location.protocol !== 'file:') void navigator.serviceWorker.register('./sw.js').catch(() => undefined)

// ───────── 画面 ─────────

const LABELS: Record<ViewName, [string, string]> = {
  home: ['ホーム', 'Home'],
  textbook: ['教科書', 'Textbook'],
  chat: ['チャット', 'Chat'],
  debate: ['ディベート', 'Debate'],
  note: ['ノート', 'Notebook'],
  memo: ['メモ', 'Memos'],
  glossary: ['用語集', 'Glossary'],
  search: ['検索', 'Search'],
  timeline: ['年表', 'Timeline'],
  essay: ['記述・論述', 'Writing practice'],
  test: ['テスト', 'Test'],
  report: ['成績', 'Report'],
  library: ['教材づくり', 'Lesson builder'],
  eikaiwa: ['英会話', 'English talk'],
  vocab: ['語彙力特訓', 'Vocabulary'],
  kanji: ['漢字特訓', 'Kanji'],
  kanjiOrder: ['書き順', 'Stroke order'],
  kanjiNote: ['漢字ノート', 'Kanji notebook'],
  settings: ['設定', 'Settings'],
  video: ['動画', 'Video'],
}
const ROUTES: Record<Route, string> = {
  relay: '開発用（この PC の Claude・Codex）',
  'own-key': '自分の API キー',
  'server-key': '運営者の API キー',
  siwc: 'Sign in with ChatGPT',
}
const AREAS = ['a', 'b', 'c']

function Shell() {
  const s = useShell()
  const [panel, setPanel] = useState(false)
  const [route, setRoute] = useState<Route | null>(null)
  const [install, setInstall] = useState<{ prompt(): Promise<unknown> } | null>(null)
  const label = (v: OpenView) => LABELS[v.view][s.lang === 'ja' ? 0 : 1]

  useEffect(() => {
    if (s.ready) void call<{ config: WebAiConfig }>('web:ai-config').then((r) => setRoute(r.config.route))
  }, [s.ready, panel])
  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault()
      setInstall(event as unknown as { prompt(): Promise<unknown> })
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  if (s.fatal) return <pre className="shell-fatal">起動できませんでした。{'\n'}{s.fatal}</pre>
  if (!s.ready) return <p className="shell-loading">学びアイを準備しています…</p>

  const stage = (
    <main className="shell-stage" data-panes={s.panes.length}>
      {s.views.map((v) => {
        const at = s.panes.indexOf(v.key)
        return (
          <iframe
            key={v.key}
            title={label(v)}
            src={`./view.html?key=${encodeURIComponent(v.key)}`}
            data-focus={s.focus === v.key && s.panes.length > 1}
            style={at >= 0 ? { gridArea: AREAS[at] } : { display: 'none' }}
            allow="microphone; clipboard-write; fullscreen"
          />
        )
      })}
    </main>
  )

  // スマートフォン: 画面を上に大きく、タブは下（親指のとどく所）に置く
  if (s.phone) {
    return (
      <div className="shell" data-phone data-bars={s.bars ? 'shown' : 'hidden'}>
        {stage}
        {!s.bars && (
          <button className="shell-bars-handle" aria-label="メニューを出す（開いている画面のタブと、画面の上のボタン）" onClick={() => setBars(true)}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M5 7h14 M5 12h14 M5 17h14" /></svg>
          </button>
        )}
        <nav className="shell-dock" aria-label="開いている画面" hidden={!s.bars}>
          <div className="shell-dock-tabs">
            {s.views.map((v) => (
              <span key={v.key} className="shell-dock-tab" data-focus={s.focus === v.key}>
                <button onClick={() => showTab(v.key)}>{label(v)}</button>
                {v.view !== 'home' && v.view !== 'test' && (
                  <button className="shell-tab-close" aria-label={`${label(v)}を閉じる`} onClick={() => closeView(v.key)}>×</button>
                )}
              </span>
            ))}
          </div>
          <button className="shell-dock-menu" aria-label="AI のつなぎ方と、この端末のデータ" onClick={() => setPanel(true)}>AI</button>
          <button className="shell-dock-menu shell-dock-hide" aria-label="メニューをかくす" onClick={() => setBars(false)}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
          </button>
        </nav>
        {panel && <AiPanel onClose={() => setPanel(false)} />}
      </div>
    )
  }

  return (
    <div className="shell">
      <header className="shell-bar">
        <strong className="shell-name">学びアイ<small>Web 版・試作</small></strong>
        <nav className="shell-tabs" aria-label="開いている画面">
          {s.views.map((v) => (
            <span key={v.key} className="shell-tab" data-shown={s.panes.includes(v.key)} data-focus={s.focus === v.key} data-pinned={s.pin?.key === v.key}>
              <button onClick={() => showTab(v.key)}>{label(v)}</button>
              {s.wide && v.view !== 'test' && !KANJI.includes(v.view) && (
                <button
                  className="shell-tab-pin"
                  aria-pressed={s.pin?.key === v.key}
                  title={s.pin?.key === v.key ? `${label(v)}の固定をやめる` : `${label(v)}を固定する（ほかの画面を開いても閉じず、ほかの画面は、となりに開きます）`}
                  aria-label={s.pin?.key === v.key ? `${label(v)}の固定をやめる` : `${label(v)}を固定する`}
                  onClick={() => setPin(v.key, s.pin?.key === v.key ? null : s.panes.length >= 2 && s.panes[0] === v.key ? 'left' : 'right')}
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill={s.pin?.key === v.key ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 3h6l-1 6 3 4H7l3-4-1-6z M12 13v8" /></svg>
                </button>
              )}
              {(v.view !== 'home' || s.views.length > 1) && v.view !== 'test' && (
                <button className="shell-tab-close" aria-label={`${label(v)}を閉じる`} onClick={() => closeView(v.key)}>×</button>
              )}
            </span>
          ))}
        </nav>
        <div className="shell-actions">
          {route === 'siwc' && (
            <span className="shell-plan">Using ChatGPT plan <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage</a></span>
          )}
          {s.wide && s.panes.length === 2 && <button title="左と右の画面を入れかえます" onClick={swapPanes}>左右を入れかえる</button>}
          {s.wide && s.views.length > 1 && !s.pin && (
            <button onClick={() => setSplit(s.panes.length === 1)}>{s.panes.length === 1 ? '2 つ並べる' : '1 つにする'}</button>
          )}
          {install && <button onClick={() => void install.prompt().then(() => setInstall(null))}>アプリとして入れる</button>}
          <button onClick={() => setPanel(true)}>AI のつなぎ方{route ? `: ${ROUTES[route].replace(/（.*/, '')}` : ''}</button>
        </div>
      </header>
      {stage}
      {panel && <AiPanel onClose={() => setPanel(false)} />}
    </div>
  )
}

interface ServerStatus {
  claude: boolean
  codex: boolean
  keys: { claude: boolean; openai: boolean }
  siwc: boolean
  siwcInfo?: { email: string; planUsage: boolean; expiresAt: number }
  cap?: { dailyUsd: number }
}
interface AiState {
  config: WebAiConfig
  server: ServerStatus | null
  /** この作りで使える方式（配る版は「自分の API キー」だけ） */
  routes: Route[]
}

function AiPanel({ onClose }: { onClose: () => void }) {
  const [ai, setAi] = useState<AiState | null>(null)
  const [usage, setUsage] = useState<UsageRow[]>([])
  const [storage, setStorage] = useState<{ files: number; bytes: number } | null>(null)
  const [message, setMessage] = useState('')
  const [models, setModels] = useState<{ slug: string; name: string }[]>([])
  const anthropicKey = useRef<HTMLInputElement>(null)
  const openaiKey = useRef<HTMLInputElement>(null)
  const polling = useRef<number>(undefined)

  const load = () => void call<AiState>('web:ai-config').then(setAi)
  useEffect(() => {
    load()
    void call<UsageRow[]>('web:ai-usage').then(setUsage)
    void call<{ files: number; bytes: number }>('web:storage').then(setStorage)
    return () => window.clearInterval(polling.current)
  }, [])
  useEffect(() => {
    if (ai?.server?.siwc) void fetch(`${BASE}api/siwc/models`).then((r) => (r.ok ? r.json() : [])).then(setModels).catch(() => setModels([]))
  }, [ai?.server?.siwc])

  const save = (patch: Partial<WebAiConfig>) => void call<AiState>('web:ai-config-set', [patch]).then(setAi)
  const signIn = async () => {
    setMessage('')
    const response = await fetch(`${BASE}api/siwc/start`, { method: 'POST' }).catch(() => null)
    const body = (await response?.json().catch(() => null)) as { url?: string; error?: string } | null
    if (!body?.url) return setMessage(body?.error ?? 'サインインを始められませんでした。付属のサーバーが動いているかを確かめてください。')
    window.open(body.url, '_blank', 'noopener')
    setMessage('開いたタブで、ChatGPT にサインインして許可してください。終わると、ここに反映されます。')
    window.clearInterval(polling.current)
    polling.current = window.setInterval(() => {
      void call<AiState>('web:ai-config').then((next) => {
        setAi(next)
        if (next.server?.siwc) {
          window.clearInterval(polling.current)
          setMessage('サインインできました。You’re using your ChatGPT plan.')
        }
      })
    }, 2500)
  }
  const signOut = async () => {
    await fetch(`${BASE}api/siwc/signout`, { method: 'POST' }).catch(() => null)
    load()
  }

  if (!ai) return null
  const { config, server } = ai
  const has = (route: Route) => ai.routes.includes(route)
  /** 付属のサーバーを使う方式があるか */
  const usesServer = ai.routes.some((route) => route !== 'own-key')
  const total = usage.reduce((sum, row) => sum + (row.cost ?? 0), 0)
  const byTask = new Map<string, { calls: number; input: number; output: number; cost: number }>()
  for (const row of usage) {
    const at = byTask.get(row.task) ?? { calls: 0, input: 0, output: 0, cost: 0 }
    byTask.set(row.task, { calls: at.calls + 1, input: at.input + row.input, output: at.output + row.output, cost: at.cost + (row.cost ?? 0) })
  }
  const option = (value: Route, note: string, ok: boolean | null) => (
    <label className="ai-route" data-on={config.route === value}>
      <input type="radio" name="route" checked={config.route === value} onChange={() => save({ route: value })} />
      <span>
        <b>{ROUTES[value]}</b>
        {ok !== null && <em data-ok={ok}>{ok ? '使えます' : '未設定'}</em>}
        <small>{note}</small>
      </span>
    </label>
  )

  return (
    <div className="ai-backdrop" onClick={onClose}>
      <section className="ai-panel" role="dialog" aria-label="AI のつなぎ方" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>AI のつなぎ方</h2>
          <button onClick={onClose}>閉じる</button>
        </header>
        {usesServer && !server && <p className="ai-warn">付属のサーバーに届きません。「自分の API キー」だけが使えます。</p>}

        {has('relay') && option('relay', 'この PC に入っている claude・codex のコマンドを、付属のサーバーが動かします。自分のプランの使用量を使います。', server ? server.claude || server.codex : false)}
        {has('relay') && config.route === 'relay' && server && <p className="ai-detail">Claude: {server.claude ? '使えます' : '見つかりません'}　／　Codex: {server.codex ? '使えます' : '見つかりません'}</p>}

        {option('own-key', 'Claude（Anthropic）か OpenAI の API キーを、自分で契約して入れます。キーは、この端末の中だけに置き、ブラウザから直接 API を呼びます。使ったぶんの料金は、キーの持ち主にかかります。', !!config.anthropicKey || !!config.openaiKey)}
        {config.route === 'own-key' && (
          <div className="ai-detail">
            <label>Claude（Anthropic）の API キー {config.anthropicKey && <em data-ok>設定ずみ</em>}
              <input ref={anthropicKey} type="password" autoComplete="off" placeholder="sk-ant-…" />
            </label>
            <label>OpenAI の API キー {config.openaiKey && <em data-ok>設定ずみ</em>}
              <input ref={openaiKey} type="password" autoComplete="off" placeholder="sk-…" />
            </label>
            <p>
              <button onClick={() => {
                const patch: Partial<WebAiConfig> = {}
                if (anthropicKey.current?.value) patch.anthropicKey = anthropicKey.current.value
                if (openaiKey.current?.value) patch.openaiKey = openaiKey.current.value
                save(patch)
                if (anthropicKey.current) anthropicKey.current.value = ''
                if (openaiKey.current) openaiKey.current.value = ''
              }}>キーを保存する</button>{' '}
              <button onClick={() => save({ anthropicKey: '', openaiKey: '' })}>キーを消す</button>
            </p>
            <label className="ai-check"><input type="checkbox" checked={config.routing} onChange={(e) => save({ routing: e.target.checked })} /> 仕事ごとに、モデルを自動で選ぶ（質問は軽いモデル、ノートの評価は上のモデル）</label>
          </div>
        )}

        {has('server-key') && option('server-key', '運営者がサーバーに置いた API キーを使います。利用者ごとの 1 日の上限と、仕事ごとのモデルは、サーバーが決めます。', server ? server.keys.claude || server.keys.openai : false)}
        {has('server-key') && config.route === 'server-key' && server && (
          <p className="ai-detail">Claude: {server.keys.claude ? '使えます' : 'キーが未設定'}　／　OpenAI: {server.keys.openai ? '使えます' : 'キーが未設定'}{server.cap ? `　／　1 人 1 日 ${server.cap.dailyUsd} ドルまで` : ''}</p>
        )}

        {has('siwc') && option('siwc', '利用者の ChatGPT のプラン（Plus・Pro）の枠を使います。OpenAI の側（設定の AI を Codex にしたとき）だけで使えます。', server ? server.siwc : false)}
        {has('siwc') && config.route === 'siwc' && (
          <div className="ai-detail">
            {server?.siwc ? (
              <>
                <p>サインイン中{server.siwcInfo?.email ? `（${server.siwcInfo.email}）` : ''}。{server.siwcInfo?.planUsage ? 'Using ChatGPT plan.' : 'このアカウントでは、プランの枠を使う許可が出ていません。'}{' '}
                  <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage</a></p>
                {models.length > 0 && (
                  <label>使うモデル{' '}
                    <select value={config.siwcModel} onChange={(e) => save({ siwcModel: e.target.value })}>
                      {models.map((m) => <option key={m.slug} value={m.slug}>{m.name}</option>)}
                    </select>
                  </label>
                )}
                <p><button onClick={() => void signOut()}>サインアウトする</button></p>
              </>
            ) : (
              <p><button className="siwc-button" onClick={() => void signIn()}>Continue with ChatGPT</button></p>
            )}
          </div>
        )}
        {message && <p className="ai-message">{message}</p>}

        <h3>この端末で使った量（直近 {usage.length} 回）</h3>
        {usage.length ? (
          <table className="ai-usage">
            <thead><tr><th>仕事</th><th>回数</th><th>入力</th><th>出力</th><th>料金の目安</th></tr></thead>
            <tbody>
              {[...byTask].map(([task, row]) => (
                <tr key={task}><td>{TASK_LABELS[task as keyof typeof TASK_LABELS] ?? task}</td><td>{row.calls}</td><td>{row.input.toLocaleString()}</td><td>{row.output.toLocaleString()}</td><td>{row.cost ? `$${row.cost.toFixed(4)}` : '—'}</td></tr>
              ))}
              <tr><th>合計</th><td>{usage.length}</td><td /><td /><td>{total ? `$${total.toFixed(4)}` : '—'}</td></tr>
            </tbody>
          </table>
        ) : <p className="ai-detail">まだ、AI を使っていません。</p>}

        <h3>この端末のデータ</h3>
        <p className="ai-detail">ノートや成績は、この端末のブラウザの中だけに残ります（{storage ? `${storage.files} 個・約 ${(storage.bytes / 1024 / 1024).toFixed(1)} MB` : '…'}）。{' '}
          <button onClick={() => window.confirm('この端末に残っているノート・成績・設定を、すべて消します。もとにはもどせません。消しますか？') && void call('web:clear-data')}>すべて消す</button>
        </p>
      </section>
    </div>
  )
}

createRoot(document.getElementById('shell')!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
)
