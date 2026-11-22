import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import { combo, isModifierCode } from '@shared/keys'
import type { ViewName, ViewParams } from '@shared/types'
import { api } from './lib/hooks'
import { useKeys } from './lib/keys'
import { Chat } from './views/Chat'
import { Debate } from './views/Debate'
import { Eikaiwa } from './views/Eikaiwa'
import { Essay } from './views/Essay'
import { Glossary } from './views/Glossary'
import { Home } from './views/Home'
import { Kanji } from './views/Kanji'
import { KanjiNote } from './views/KanjiNote'
import { KanjiOrder } from './views/KanjiOrder'
import { Library } from './views/Library'
import { Memo } from './views/Memo'
import { Note } from './views/Note'
import { Report } from './views/Report'
import { Search } from './views/Search'
import { Settings } from './views/Settings'
import { Test } from './views/Test'
import { Textbook } from './views/Textbook'
import { Timeline } from './views/Timeline'
import { Video } from './views/Video'
import { Vocab } from './views/Vocab'
import { tx } from '@/lib/i18n'

function Screen({ view, params }: { view: ViewName; params: ViewParams }) {
  switch (view) {
    case 'textbook':
      return <Textbook params={params} />
    case 'chat':
      return <Chat params={params} />
    case 'debate':
      return <Debate params={params} />
    case 'note':
      return <Note params={params} />
    case 'memo':
      return <Memo />
    case 'glossary':
      return <Glossary params={params} />
    case 'search':
      return <Search params={params} />
    case 'timeline':
      return <Timeline />
    case 'essay':
      return <Essay params={params} />
    case 'test':
      return <Test params={params} />
    case 'report':
      return <Report />
    case 'library':
      return <Library />
    case 'vocab':
      return <Vocab />
    case 'eikaiwa':
      return <Eikaiwa />
    case 'kanji':
      return <Kanji />
    case 'kanjiOrder':
      return <KanjiOrder />
    case 'kanjiNote':
      return <KanjiNote />
    case 'settings':
      return <Settings />
    case 'video':
      return <Video params={params} />
    default:
      return <Home />
  }
}

/** 画面の中でエラーが起きたとき、白いままにせず、わけを出す（何が起きたかを、あとで調べられるように） */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? `${error.message}\n${(error.stack ?? '').split('\n').slice(0, 4).join('\n')}` : String(error) }
  }
  render() {
    if (this.state.error === null) return this.props.children
    return (
      <div className="view-error">
        <p><strong>この画面を表示できませんでした。</strong></p>
        <pre className="view-error-detail">{this.state.error}</pre>
        <button className="btn" onClick={() => location.reload()}>読みこみ直す</button>
      </div>
    )
  }
}

/** ウィンドウごとに 1 つのモードを表示する。どのモードかはメインプロセスに問い合わせる。 */
export function App() {
  const [state, setState] = useState<{ view: ViewName; params: ViewParams } | null>(null)
  /** 表示倍率を変えた直後だけ出す、いまの倍率の表示 */
  const [zoomShown, setZoomShown] = useState<number | null>(null)
  const zoom = useRef<number | null>(null)
  const timer = useRef<number>(undefined)
  const keys = useKeys()
  const keysRef = useRef(keys)
  keysRef.current = keys

  useEffect(() => {
    void api.view.get().then(setState)
    return api.view.onParams((params) => setState((prev) => (prev ? { ...prev, params } : prev)))
  }, [])

  useEffect(() => {
    if (state) document.body.dataset['view'] = state.view
  }, [state])

  // 表示倍率: どの画面でも、ショートカットで変えられる（割り当ては設定の画面で変えられる）
  useEffect(() => {
    const show = (value: number) => {
      if (zoom.current !== null && zoom.current !== value) {
        setZoomShown(value)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setZoomShown(null), 1400)
      }
      zoom.current = value
    }
    void api.zoom.get().then(show)
    const onKey = (e: KeyboardEvent) => {
      if (isModifierCode(e.code)) return
      const value = combo(e, e.code)
      const k = keysRef.current
      // 画面の固定（右・左・やめる）
      const pin = value === k['pinRight'] ? 'right' : value === k['pinLeft'] ? 'left' : value === k['pinOff'] ? null : undefined
      if (value && pin !== undefined) {
        e.preventDefault()
        return void api.view.pin(pin)
      }
      const direction = value === k['zoomIn'] ? 1 : value === k['zoomOut'] ? -1 : value === k['zoomReset'] ? 0 : null
      if (direction === null) return
      // 文字を入力している間は、Ctrl や Alt を使わない割り当ては働かせない
      const typing = ['TEXTAREA', 'INPUT', 'SELECT'].includes((e.target as HTMLElement).tagName)
      if (typing && !e.ctrlKey && !e.altKey) return
      e.preventDefault()
      void api.zoom.step(direction)
    }
    window.addEventListener('keydown', onKey)
    const off = api.onChanged((topic) => topic === 'zoom' && void api.zoom.get().then(show))
    return () => {
      window.removeEventListener('keydown', onKey)
      window.clearTimeout(timer.current)
      off()
    }
  }, [])

  if (!state) return null
  return (
    <>
      <ErrorBoundary>
        <Screen view={state.view} params={state.params} />
      </ErrorBoundary>
      {zoomShown !== null && (
        <p className="zoom-chip" role="status">{tx('表示 {0}%', Math.round(zoomShown * 100))}</p>
      )}
    </>
  )
}
