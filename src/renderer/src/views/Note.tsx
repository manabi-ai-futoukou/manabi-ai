import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { combo, isModifierCode } from '@shared/keys'
import { PAGE_H, PAGE_W, spreadPages } from '@shared/page'
import { inkStamp, type NoteObject, type Notebook, type NotePage, type Ruling, type ShapeObject, type ViewParams } from '@shared/types'
import { MicButton } from '../components/MicButton'
import { PinButton } from '../components/PinButton'
import { api, errorMessage, useLoad, usePhone, useToast } from '../lib/hooks'
import { useKeys } from '../lib/keys'
import { transcribePages } from '../lib/transcribe'
import { EvaluationPanel } from '../note/EvaluationPanel'
import { boxOf } from '../note/objects'
import { PageSurface, type Tool } from '../note/PageSurface'
import { PenDiagnostics } from '../note/PenDiagnostics'
import { isBlank, renderPageImage } from '../note/render'
import { TranscriptPanel } from '../note/TranscriptPanel'
import { t, tx } from '@/lib/i18n'
import { newId } from '../lib/id'

const PEN_COLORS = [
  { value: '#23232b', label: t('黒') },
  { value: '#d2553f', label: t('赤') },
  { value: '#2f6fb7', label: t('青') },
  { value: '#2f9467', label: t('緑') },
]
const MARKER_COLORS = [
  { value: '#ffd92e', label: t('黄') },
  { value: '#ff9d7a', label: t('オレンジ') },
  { value: '#7fdc8f', label: t('緑') },
  { value: '#7cc8ff', label: t('水色') },
]
const PEN_SIZES = [
  { value: 2.5, label: t('極細') },
  { value: 4, label: t('細め') },
  { value: 6, label: t('細い') },
  { value: 9, label: t('ふつう') },
  { value: 15, label: t('太い') },
]
const MARKER_SIZE = 55
/** 消しゴムの大きさ（半径。1 = 0.1mm） */
const ERASER_SIZES = [
  { value: 12, label: t('小') },
  { value: 25, label: t('中') },
  { value: 50, label: t('大') },
  { value: 100, label: t('特大') },
]
/** 書き終わってから保存を始めるまでの間（ミリ秒）。続けて書いているあいだは、保存しない */
const SAVE_DELAY = 1500
const SPACINGS = [5, 6, 7, 8, 10, 12, 15, 20]
/** ページの拡大率の範囲（1 = 見開きがちょうど収まる大きさ） */
const clampPageZoom = (value: number) => Math.round(Math.max(1, Math.min(4, value)) * 100) / 100
/** 一度に先生へ見せるページ数の上限 */
const MAX_EVALUATION_PAGES = 8

const TOOLS: { id: Tool; label: string; icon: string }[] = [
  { id: 'pen', label: t('ペン'), icon: 'M4 20l3.5-1L19 7.5 16.5 5 5 16.5 4 20z M14.5 7l2.5 2.5' },
  { id: 'marker', label: t('マーカー'), icon: 'M9 19H4v-3L15 5l4 4-10 10z M12 8l4 4 M4 22h16' },
  { id: 'eraser', label: t('消しゴム'), icon: 'M8 20h12 M5 15l9-9 5 5-9 9H7l-2-2a2 2 0 010-3z M10 11l5 5' },
  { id: 'text', label: t('文字'), icon: 'M5 6h14 M12 6v13 M9 19h6' },
  { id: 'shape', label: t('図形'), icon: 'M4 4h9v9H4z M17 20a4 4 0 100-8 4 4 0 000 8z' },
  { id: 'select', label: t('選択'), icon: 'M6 4l12 8-5.5 1.2L15 19l-2.5 1-2.3-5.8L6 18z' },
]
const SHAPES: { kind: ShapeObject['kind']; label: string; icon: string }[] = [
  { kind: 'line', label: t('直線'), icon: 'M5 19L19 5' },
  { kind: 'arrow', label: t('矢印'), icon: 'M5 19L19 5 M11 5h8v8' },
  { kind: 'rect', label: t('四角'), icon: 'M5 6h14v12H5z' },
  { kind: 'ellipse', label: t('円'), icon: 'M12 19a7 7 0 100-14 7 7 0 000 14z' },
]

interface Change {
  index: number
  before: NotePage
  after: NotePage
}

type Panel = 'evaluation' | 'transcript' | 'search' | 'pen'

const blankPage = (): NotePage => ({ id: newId(), strokes: [], texts: [] })

function Icon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={path} />
    </svg>
  )
}

/** ノートモード。見開き 2 ページに、ペンで自由に書きこむ。 */
export function Note({ params }: { params: ViewParams }) {
  const notebookId = params.notebookId ?? ''
  const [notebook, setNotebook] = useState<Notebook | null>(null)
  const current = useRef<Notebook | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [spread, setSpread] = useState(0)
  /** スマートフォンでは、見開きではなく 1 ページずつ見せる（side: 見開きの左 = 0・右 = 1） */
  const phone = usePhone()
  /** 利き手（道具の列を、その側に置く） */
  const prefs = useLoad(() => api.settings.get(), [], ['settings'])
  const hand = prefs.data?.handedness === 'left' ? 'left' : 'right'
  /** いま見せているページ（キーでページを送るときに使う） */
  const pageRef = useRef(0)
  /** ページを、いまの位置から step だけ送る（見開きの左右をまたぐ） */
  const turnBy = useCallback((step: number) => {
    const next = Math.max(0, Math.min((current.current?.pages.length ?? 1) - 1, pageRef.current + step))
    setSpread(Math.floor(next / 2))
    setSide((next % 2) as 0 | 1)
  }, [])
  const [side, setSide] = useState<0 | 1>(0)
  const [tool, setTool] = useState<Tool>('pen')
  const [penColor, setPenColor] = useState(PEN_COLORS[0].value)
  const [markerColor, setMarkerColor] = useState(MARKER_COLORS[0].value)
  const [penSize, setPenSize] = useState(9)
  const [eraserSize, setEraserSize] = useState(25)
  /** 消しゴムの消し方。偽: 通ったところだけを消す / 真: 触れた線を 1 本まるごと消す */
  const [eraseWhole, setEraseWhole] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [shapeKind, setShapeKind] = useState<ShapeObject['kind']>('line')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [insertOpen, setInsertOpen] = useState(false)
  const [tableSize, setTableSize] = useState({ rows: 3, cols: 3 })
  const [graphRange, setGraphRange] = useState(5)
  const [link, setLink] = useState({ url: '', title: '' })
  /** タイピングモード（罫線に沿ってキーボードで入力する）。偽なら手書きモード */
  const [typing, setTyping] = useState(false)
  const [region, setRegion] = useState<'rect' | 'lasso'>('rect')
  /** 最後に触れたページ（Delete キーで書きこみを消す対象） */
  const [activePage, setActivePage] = useState(0)
  /** ページをつかんで動かした量（画面上のピクセル）と、スペースキーを押している間の「つかむ」状態 */
  const [pan, setPan] = useState({ x: 0, y: 0 })
  /** 割り当てたキーを押している間の操作。pan: ページをつかんで動かす / zoom: ドラッグで拡大・縮小する */
  const [gesture, setGesture] = useState<'pan' | 'zoom' | null>(null)
  /** ドラッグで拡大・縮小している途中の見た目（離したときに、本当の拡大率に反映する） */
  const [preview, setPreview] = useState<{ scale: number; origin: string } | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  /** 拡大率を変える前に、見えている範囲のまん中にあった点（見開きに対する 0〜1 の位置） */
  const anchor = useRef<{ x: number; y: number } | null>(null)
  const clearActivePage = useRef(() => {})
  const [panel, setPanel] = useState<Panel | null>('evaluation')
  const [rulingOpen, setRulingOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [jump, setJump] = useState('')
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved')
  const [evaluating, setEvaluating] = useState(false)
  const [evaluationError, setEvaluationError] = useState<string | null>(null)
  /** 手書きの文字起こしの途中経過（していないときは null） */
  const [transcribing, setTranscribing] = useState<{ done: number; total: number } | null>(null)
  const [transcribeError, setTranscribeError] = useState<string | null>(null)
  const history = useRef<{ undo: Change[]; redo: Change[] }>({ undo: [], redo: [] })
  const [, refresh] = useReducer((n: number) => n + 1, 0)
  const saveTimer = useRef<number>(undefined)
  const dirty = useRef(false)
  const { toast, show } = useToast()

  const characters = useLoad(() => api.characters.list(), [], ['characters'])
  const evaluations = useLoad(
    () => (notebookId ? api.notes.evaluations(notebookId) : Promise.resolve([])),
    [notebookId],
    ['evaluations'],
  )
  const teacher = characters.data?.find((c) => c.role === 'teacher')
  /** 特訓用のノートでは、いま練習している言葉を表示し、「書けた！」で AI に確かめてもらう */
  const vocab = useLoad(() => api.vocab.state(), [], ['vocab'])
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    if (!notebookId) return
    void api.notes
      .get(notebookId)
      .then((loaded) => {
        if (!loaded) return setLoadError(t('ノートが見つかりませんでした。'))
        current.current = loaded
        setNotebook(loaded)
        // テスト用のノートは計算に使うだけなので、評価のパネルは出さない。メモにも、評価は無い。
        // せまい画面（Web 版で 2 つ並べたときなど）では、右の欄が紙に重なるので、はじめは閉じておく
        if (loaded.kind === 'test' || loaded.kind === 'drill' || loaded.kind === 'memo' || document.body.clientWidth < 900) setPanel(null)
      })
      .catch((e) => setLoadError(errorMessage(e)))
  }, [notebookId])

  // まとめての文字起こし（メモの一覧の画面）が、このノートに文字起こしを書きこんだら、開いている中身にも入れる
  useEffect(() => {
    if (!notebookId) return
    return api.onChanged((topic) => {
      if (topic !== `transcript:${notebookId}`) return
      void api.notes.get(notebookId).then((saved) => {
        const latest = current.current
        if (!saved || !latest) return
        const pages = latest.pages.map((page) => {
          const found = saved.pages.find((p) => p.id === page.id)
          return found?.transcriptStamp && found.transcriptStamp === inkStamp(page) && found.transcriptStamp !== page.transcriptStamp ? { ...page, transcript: found.transcript, transcriptStamp: found.transcriptStamp } : page
        })
        if (pages.some((page, i) => page !== latest.pages[i])) {
          current.current = { ...latest, pages }
          setNotebook(current.current)
        }
      })
    })
  }, [notebookId])

  // 検索の結果などから、ページを指定して開かれたとき
  useEffect(() => {
    if (params.page && notebook) {
      const index = Math.max(0, Math.min(notebook.pages.length - 1, params.page - 1))
      setSpread(Math.floor(index / 2))
      setSide((index % 2) as 0 | 1)
    }
  }, [params.page, notebook?.id])

  // ───────── 保存 ─────────

  const saveNow = useCallback(async () => {
    window.clearTimeout(saveTimer.current)
    if (!dirty.current || !current.current) return
    dirty.current = false
    setSaveState('saving')
    try {
      await api.notes.save(current.current)
      setSaveState((state) => (state === 'saving' ? 'saved' : state))
    } catch {
      dirty.current = true
      setSaveState('error')
    }
  }, [])

  /** ノートを書きかえる。少し間をおいて自動で保存する。 */
  const apply = useCallback(
    (next: Notebook) => {
      current.current = next
      setNotebook(next)
      dirty.current = true
      setSaveState('dirty')
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => void saveNow(), SAVE_DELAY)
    },
    [saveNow],
  )

  // 書いているあいだ（ペンや指が下りているあいだ）は、保存を始めない。
  // iPad では、保存（ノート全体をワーカーへ渡す）が、次の線の描きはじめを待たせてしまう
  useEffect(() => {
    const hold = () => window.clearTimeout(saveTimer.current)
    const release = () => {
      if (!dirty.current) return
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => void saveNow(), SAVE_DELAY)
    }
    window.addEventListener('pointerdown', hold, true)
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointercancel', release, true)
    return () => {
      window.removeEventListener('pointerdown', hold, true)
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('pointercancel', release, true)
    }
  }, [saveNow])

  useEffect(() => {
    const flush = () => void saveNow()
    window.addEventListener('beforeunload', flush)
    window.addEventListener('blur', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('blur', flush)
    }
  }, [saveNow])

  // ───────── 編集と、元に戻す・やり直す ─────────

  const replacePage = (index: number, page: NotePage) => {
    const nb = current.current!
    apply({ ...nb, pages: nb.pages.map((p, i) => (i === index ? page : p)) })
  }

  const commitPage = (index: number, next: NotePage) => {
    history.current.undo.push({ index, before: current.current!.pages[index], after: next })
    history.current.redo = []
    replacePage(index, next)
  }

  const undo = useCallback(() => {
    const change = history.current.undo.pop()
    if (!change) return
    history.current.redo.push(change)
    replacePage(change.index, change.before)
    setSpread(Math.floor(change.index / 2))
    setSide((change.index % 2) as 0 | 1)
    refresh()
  }, [apply])

  const redo = useCallback(() => {
    const change = history.current.redo.pop()
    if (!change) return
    history.current.undo.push(change)
    replacePage(change.index, change.after)
    setSpread(Math.floor(change.index / 2))
    setSide((change.index % 2) as 0 | 1)
    refresh()
  }, [apply])

  // ───────── 指のジェスチャー（iPad・Chromebook など、画面に指で触れる機器）─────────
  // 2 本指で軽くたたく = 元に戻す ／ 3 本指で軽くたたく = やり直す ／ 2 本指で動かす = ノートを動かす ／ 2 本指を開く・閉じる = 拡大・縮小
  const fingers = useRef({ zoom: 1, zoomTo: (_next: number) => undefined as void, undo: () => undefined as void, redo: () => undefined as void })
  fingers.current.zoom = zoom
  fingers.current.undo = undo
  fingers.current.redo = redo
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const touches = new Map<number, { x: number; y: number }>()
    /** 指が 1 本でも触れてから、全部はなれるまで */
    let session: { startedAt: number; most: number; moved: number; span: number; zoom: number; x: number; y: number } | null = null
    const middle = () => {
      let x = 0
      let y = 0
      for (const p of touches.values()) {
        x += p.x
        y += p.y
      }
      return { x: x / touches.size, y: y / touches.size }
    }
    const spanOf = () => {
      const [a, b] = [...touches.values()]
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
    }
    /** 指の本数が変わったら、動きを測る基準を取り直す */
    const rebase = () => {
      if (!session || !touches.size) return
      const c = middle()
      session.x = c.x
      session.y = c.y
      session.span = spanOf()
      session.zoom = fingers.current.zoom
    }
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (!session) session = { startedAt: performance.now(), most: 0, moved: 0, span: 0, zoom: fingers.current.zoom, x: e.clientX, y: e.clientY }
      session.most = Math.max(session.most, touches.size)
      // 2 本めの指が触れたら、1 本めの指で書きかけた線（指で書けるスマートフォン）は捨てる
      if (touches.size === 2) for (const page of stage.querySelectorAll('.note-page')) page.dispatchEvent(new Event('note-discard'))
      rebase()
    }
    const move = (e: PointerEvent) => {
      const point = touches.get(e.pointerId)
      if (!point || !session) return
      point.x = e.clientX
      point.y = e.clientY
      if (touches.size < 2) return
      e.preventDefault()
      const c = middle()
      const dx = c.x - session.x
      const dy = c.y - session.y
      session.moved += Math.abs(dx) + Math.abs(dy)
      // 2 本指で動かす: 見えている範囲を、指といっしょに動かす
      stage.scrollLeft -= dx
      stage.scrollTop -= dy
      session.x = c.x
      session.y = c.y
      // 2 本指を開く・閉じる: 拡大・縮小（小さなゆれでは変えない）
      if (touches.size === 2 && session.span > 0) {
        const ratio = spanOf() / session.span
        if (Math.abs(ratio - 1) > 0.05) {
          session.moved += 100
          fingers.current.zoomTo(session.zoom * ratio)
        }
      }
    }
    const up = (e: PointerEvent) => {
      if (!touches.delete(e.pointerId) || !session) return
      if (touches.size) return rebase()
      // 全部の指がはなれた。短い時間で、ほとんど動いていなければ「軽くたたいた」とみる
      const tapped = performance.now() - session.startedAt < 350 && session.moved < 24
      const most = session.most
      session = null
      if (tapped && most === 2) fingers.current.undo()
      else if (tapped && most === 3) fingers.current.redo()
    }
    stage.addEventListener('pointerdown', down, true)
    stage.addEventListener('pointermove', move, { capture: true, passive: false })
    stage.addEventListener('pointerup', up, true)
    stage.addEventListener('pointercancel', up, true)
    return () => {
      stage.removeEventListener('pointerdown', down, true)
      stage.removeEventListener('pointermove', move, true)
      stage.removeEventListener('pointerup', up, true)
      stage.removeEventListener('pointercancel', up, true)
    }
  }, [notebook?.id])

  // ショートカット（割り当ては、設定の画面で変えられる）
  const keys = useKeys()
  const keysRef = useRef(keys)
  keysRef.current = keys
  useEffect(() => {
    // 文字を入力している欄では、ショートカットを働かせない（読むだけになっている欄は、入力中ではないので働かせる）
    const inField = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      return ['TEXTAREA', 'INPUT', 'SELECT'].includes(target.tagName) && !(target as HTMLTextAreaElement).readOnly
    }
    /** 押したままになっている（Ctrl・Shift・Alt でない）キー */
    let held: string | null = null
    const gestureOf = (e: KeyboardEvent) => {
      const value = held ? combo(e, held) : ''
      return !value ? null : value === keysRef.current['noteZoom'] ? 'zoom' : value === keysRef.current['notePan'] ? 'pan' : null
    }
    const onKey = (e: KeyboardEvent) => {
      if (inField(e)) return
      if (!isModifierCode(e.code)) held = e.code
      const next = gestureOf(e)
      setGesture(next)
      if (next) return e.preventDefault()
      if (isModifierCode(e.code)) return
      const value = combo(e, e.code)
      const k = keysRef.current
      const pick = (tool: Tool) => {
        setTyping(false)
        setTool(tool)
      }
      if (value === k['noteUndo']) undo()
      else if (value === k['noteRedo']) redo()
      else if (value === k['notePrev']) turnBy(-1)
      else if (value === k['noteNext']) turnBy(1)
      else if (value === k['noteSelect']) pick('select')
      else if (value === k['notePen']) pick('pen')
      else if (value === k['noteEraser']) pick('eraser')
      else if (value === k['noteTyping']) setTyping((on) => !on)
      else if (value === k['noteClearPage']) clearActivePage.current()
      else return
      e.preventDefault()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === held) held = null
      setGesture(gestureOf(e))
    }
    const release = () => {
      held = null
      setGesture(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', release)
    }
  }, [undo, redo])

  // 拡大率を変えたあと、まん中に見えていた点が、また同じ場所に見えるようにスクロールを合わせる
  useLayoutEffect(() => {
    const at = anchor.current
    const stage = stageRef.current
    const sheet = stage?.querySelector<HTMLElement>('.spread')?.getBoundingClientRect()
    if (!at || !stage || !sheet) return
    anchor.current = null
    const view = stage.getBoundingClientRect()
    stage.scrollLeft += sheet.left + at.x * sheet.width - (view.left + view.width / 2)
    stage.scrollTop += sheet.top + at.y * sheet.height - (view.top + view.height / 2)
  }, [zoom])

  // ───────── 検索 ─────────

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !notebook) return []
    const found: { page: number; kind: string; snippet: string }[] = []
    notebook.pages.forEach((page, i) => {
      const sources = [
        ...page.texts.map((box) => ({ kind: t('入力した文字'), text: box.text })),
        ...(page.typed ? [{ kind: t('タイピング'), text: page.typed }] : []),
        ...(page.transcript ? [{ kind: t('手書き'), text: page.transcript }] : []),
      ]
      for (const source of sources) {
        const at = source.text.toLowerCase().indexOf(q)
        if (at < 0) continue
        const from = Math.max(0, at - 14)
        found.push({
          page: i + 1,
          kind: source.kind,
          snippet: `${from > 0 ? '…' : ''}${source.text.slice(from, at + q.length + 26).replace(/\s+/g, ' ')}`,
        })
      }
    })
    return found
  }, [query, notebook])

  if (loadError) return <p className="view-error">{loadError}</p>
  if (!notebook) return null

  const spreads = Math.ceil(notebook.pages.length / 2)
  const [leftIndex] = spreadPages(spread)
  /** 画面に出すページ（1 ページずつ見せる。side が、見開きの左 = 0・右 = 1） */
  const shownPages = [notebook.pages[spread * 2 + side] ? spread * 2 + side : leftIndex]
  const single = shownPages[0]
  pageRef.current = single
  /** スマートフォンで、前・次のページへ（見開きをまたぐ） */
  const turnPage = (step: -1 | 1) => {
    const next = Math.max(0, Math.min(notebook.pages.length - 1, single + step))
    setSpread(Math.floor(next / 2))
    setSide((next % 2) as 0 | 1)
    setActivePage(next)
  }
  const color = tool === 'marker' ? markerColor : penColor
  const size = tool === 'marker' ? MARKER_SIZE : penSize

  const goToPage = (pageNumber: number) => {
    const clamped = Math.max(1, Math.min(notebook.pages.length, Math.round(pageNumber) || 1))
    setSpread(Math.floor((clamped - 1) / 2))
    setSide(((clamped - 1) % 2) as 0 | 1)
  }

  const addSpread = () => {
    apply({ ...notebook, pages: [...notebook.pages, blankPage(), blankPage()] })
    setSpread(spreads)
    // 足した 2 ページのうち、先のページを見せる
    setSide(0)
  }

  const changeRuling = (ruling: Ruling) => {
    apply({ ...notebook, ruling })
    // ふだんのノートで選んだ罫線だけを、次に作るノートの初期値として覚える
    if (!notebook.kind || notebook.kind === 'lesson') void api.settings.set({ ruling })
  }

  /** 開いている見開きの左ページ（無ければ右ページ）に、部品を置く */
  const insert = (make: (place: (w: number, h: number) => { x: number; y: number; w: number; h: number }) => NoteObject) => {
    const index = single
    const page = notebook.pages[index]
    if (!page) return
    const existing = page.objects ?? []
    // 横は中央。縦は、すでにある部品の下に続けて置く。下に入りきらないときは、上のほうへ少しずつずらして置く
    const below = Math.max(420, ...existing.map((o) => boxOf(o).y + boxOf(o).h + 60))
    const object = make((w, h) => ({
      x: Math.round((PAGE_W - w) / 2),
      y: below + h <= PAGE_H - 150 ? below : 420 + (existing.length % 5) * 70,
      w,
      h,
    }))
    commitPage(index, { ...page, objects: [...(page.objects ?? []), object] })
    refresh()
    setTool('select')
    setSelectedId(object.id)
    setInsertOpen(false)
  }

  const insertTable = () =>
    insert((place) => ({
      id: newId(),
      type: 'table',
      ...place(Math.min(1500, tableSize.cols * 300), tableSize.rows * 100),
      cells: Array.from({ length: tableSize.rows }, () => Array<string>(tableSize.cols).fill('')),
    }))
  const insertGraph = () => insert((place) => ({ id: newId(), type: 'graph', ...place(900, 900), range: graphRange }))
  const insertImage = async () => {
    try {
      const picked = await api.attachments.pickImage()
      if (!picked) return
      // ページの幅に収まる大きさで置く（あとで大きさは変えられる）
      const w = Math.min(1000, picked.width * 2)
      const h = Math.round((w * picked.height) / picked.width)
      insert((place) => ({ id: newId(), type: 'image', ...place(w, h), attachmentId: picked.attachmentId, name: picked.name }))
    } catch (e) {
      show(errorMessage(e), 'error')
    }
  }
  const insertVideo = async () => {
    const picked = await api.attachments.pickVideo()
    if (!picked) return
    insert((place) => ({ id: newId(), type: 'link', kind: 'video', ...place(1000, 150), target: picked.path, title: picked.name }))
  }
  const insertLink = () => {
    const url = link.url.trim()
    if (!/^https?:\/\/\S+$/i.test(url)) return show(t('http:// または https:// で始まるアドレスを入力してください。'), 'error')
    insert((place) => ({ id: newId(), type: 'link', kind: 'link', ...place(1000, 150), target: url, title: link.title.trim() || url }))
    setLink({ url: '', title: '' })
  }

  const exportPdf = async () => {
    const lastUsed = notebook.pages.reduce((last, page, i) => (isBlank(page) ? last : i), 1)
    const images = await Promise.all(notebook.pages.slice(0, lastUsed + 1).map((page) => renderPageImage(page, notebook.ruling, 1456)))
    try {
      const result = await api.notes.exportPdf(notebook.title, images)
      if (result.saved) show(t('PDF を保存しました: {0}', result.path))
    } catch (e) {
      show(t('PDF を保存できませんでした。{0}', errorMessage(e)), 'error')
    }
  }

  const evaluate = async () => {
    if (evaluating) return
    setPanel('evaluation')
    const filled = notebook.pages.map((page, index) => ({ page, index })).filter(({ page }) => !isBlank(page))
    if (!filled.length) {
      setEvaluationError(t('まだ何も書かれていません。ノートに書いてから、もう一度お試しください。'))
      return
    }
    // ページが多いときは、いま開いている見開きに近いページを優先する
    const center = spread * 2 + 0.5
    const chosen = [...filled]
      .sort((a, b) => Math.abs(a.index - center) - Math.abs(b.index - center))
      .slice(0, MAX_EVALUATION_PAGES)
      .sort((a, b) => a.index - b.index)
      .map((item) => ({ ...item, stamp: inkStamp(item.page) }))

    setEvaluating(true)
    setEvaluationError(null)
    try {
      await saveNow()
      const result = await api.notes.evaluate({
        notebookId: notebook.id,
        pages: await Promise.all(
          chosen.map(async ({ page, index }) => ({ page: index + 1, image: await renderPageImage(page, notebook.ruling, 1100) })),
        ),
      })
      // AI が読み取った手書きの内容を覚えておく（検索で使う）
      const latest = current.current!
      apply({
        ...latest,
        pages: latest.pages.map((page, i) =>
          result.transcripts[i + 1] !== undefined ? { ...page, transcript: result.transcripts[i + 1], transcriptStamp: chosen.find((c) => c.index === i)?.stamp ?? inkStamp(page) } : page,
        ),
      })
      evaluations.reload()
      if (result.reward > 0) show(t('ノートを見てもらって、みんなの好感度が {0} 増えました。', result.reward))
    } catch (e) {
      setEvaluationError(errorMessage(e))
    } finally {
      setEvaluating(false)
    }
  }

  /** 手書きの文字起こしだけをする（評価はしない）。spread: 開いているページ / all: ノート全体 */
  const transcribe = async (scope: 'spread' | 'all') => {
    if (transcribing) return
    setPanel('transcript')
    const snapshot = current.current!
    const indexes = (scope === 'all' ? snapshot.pages.map((_, i) => i) : [single]).filter((i) => snapshot.pages[i]?.strokes.length)
    if (!indexes.length) return setTranscribeError(t('手書きのあるページがありません。'))
    setTranscribeError(null)
    setTranscribing({ done: 0, total: indexes.length })
    try {
      await saveNow()
      // 1 回ぶん（数ページ）が終わるたびに、ノートへ入れる（途中で止まっても、終わったぶんは残る）
      for (let at = 0; at < indexes.length; at += 4) {
        const results = await transcribePages(current.current!, indexes.slice(at, at + 4))
        const latest = current.current!
        apply({
          ...latest,
          pages: latest.pages.map((page) => {
            const found = results.find((r) => r.pageId === page.id)
            return found ? { ...page, transcript: found.text, transcriptStamp: found.stamp } : page
          }),
        })
        setTranscribing({ done: Math.min(indexes.length, at + 4), total: indexes.length })
      }
    } catch (e) {
      setTranscribeError(errorMessage(e))
    } finally {
      setTranscribing(null)
    }
  }

  /** 文字起こしを、タイピングの文字としてページに入れる。replace が真なら、手書きを消して置きかえる */
  const insertTranscript = (index: number, replace: boolean) => {
    const page = current.current?.pages[index]
    const text = page?.transcript?.trim()
    if (!page || !text) return
    const typed = page.typed?.trim() ? `${page.typed}\n${text}` : text
    commitPage(index, replace ? { ...page, strokes: [], typed, transcript: undefined, transcriptStamp: undefined } : { ...page, typed })
    refresh()
    show(replace ? t('p.{0} の手書きを、文字に置きかえました（Ctrl + Z で元に戻せます）', index + 1) : t('p.{0} に、文字として入れました（Ctrl + Z で元に戻せます）', index + 1))
  }

  /** 特訓用のノート: 開いている見開きを AI に見せて、課題ができているかを確かめてもらう */
  const checkDrill = async () => {
    if (checking) return
    await saveNow()
    const latest = current.current!
    const pages = [single].map((i) => latest.pages[i]).filter((page): page is NotePage => !!page && !isBlank(page))
    if (!pages.length) return show(t('まだ何も書かれていません。ノートに書いてから、もう一度押してください。'), 'error')
    const target = vocab.data?.word?.word ?? ''
    setChecking(true)
    try {
      const state = await api.vocab.check(await Promise.all(pages.map((page) => renderPageImage(page, latest.ruling, 1100))))
      const check = state.last?.check
      if (check?.ok) show(t('「{0}」は合格です！{1}', target, state.word ? t(' 次の言葉は「{0}」です。', state.word.word) : ''))
      else if (check) show(t('もう少しです（言葉 {0} 回、例文 {1} 文）。くわしくは、言葉のウィンドウを見てください。', check.wordCount, check.sentences.filter((s) => s.ok).length))
    } catch (e) {
      show(errorMessage(e), 'error')
    } finally {
      setChecking(false)
    }
  }

  // Delete キー: 最後に触れたページの書きこみを、すべて消す（範囲を選んでいるときは、ページ側がその範囲だけを消す）
  clearActivePage.current = () => {
    const page = notebook.pages[activePage]
    if (!page || isBlank(page)) return
    commitPage(activePage, { ...page, strokes: [], texts: [], objects: [], typed: '' })
    refresh()
    show(t('p.{0} の書きこみをすべて消しました（Ctrl + Z で元に戻せます）', activePage + 1))
  }

  /** 見えている範囲のまん中が、見開きのどこに当たるか */
  const viewCenter = () => {
    const stage = stageRef.current
    const sheet = stage?.querySelector<HTMLElement>('.spread')?.getBoundingClientRect()
    if (!stage || !sheet) return null
    const view = stage.getBoundingClientRect()
    return { x: view.left + view.width / 2 - sheet.left, y: view.top + view.height / 2 - sheet.top, sheet }
  }

  /** ページの拡大率を変える（見えている範囲のまん中を軸にする） */
  const zoomTo = (next: number): void => {
    const center = viewCenter()
    if (center) anchor.current = { x: center.x / center.sheet.width, y: center.y / center.sheet.height }
    setZoom(clampPageZoom(next))
  }
  fingers.current.zoomTo = zoomTo

  /** 割り当てたキーを押しながらドラッグ: ページをつかんで動かす、または拡大・縮小する */
  const startGesture = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!gesture) return
    e.preventDefault()
    e.stopPropagation()
    const stage = e.currentTarget
    stage.setPointerCapture(e.pointerId)
    const track = (move: (ev: PointerEvent) => void, done?: () => void) => {
      const end = () => {
        stage.removeEventListener('pointermove', move)
        stage.removeEventListener('pointerup', end)
        stage.removeEventListener('pointercancel', end)
        done?.()
      }
      stage.addEventListener('pointermove', move)
      stage.addEventListener('pointerup', end)
      stage.addEventListener('pointercancel', end)
    }
    const startX = e.clientX
    const startY = e.clientY
    if (gesture === 'pan') {
      const from = pan
      return track((ev) => setPan({ x: from.x + ev.clientX - startX, y: from.y + ev.clientY - startY }))
    }
    // 拡大・縮小: 右上へ動かすと大きく、左下へ動かすと小さくなる。動かしている間は見た目だけを変え、離したときに確定する
    const center = viewCenter()
    if (!center) return
    let next = zoom
    track(
      (ev) => {
        next = clampPageZoom(zoom * Math.exp((ev.clientX - startX - (ev.clientY - startY)) / 260))
        setPreview({ scale: next / zoom, origin: `${center.x}px ${center.y}px` })
      },
      () => {
        anchor.current = { x: center.x / center.sheet.width, y: center.y / center.sheet.height }
        setPreview(null)
        setZoom(next)
      },
    )
  }

  const togglePanel = (name: Panel) => setPanel((open) => (open === name ? null : name))
  const isTest = notebook.kind === 'test'
  const isDrill = notebook.kind === 'drill'
  const isMemo = notebook.kind === 'memo'
  const saveLabel = { saved: t('保存済み'), dirty: t('保存します…'), saving: t('保存中…'), error: t('保存できませんでした') }[saveState]

  return (
    <div className="note" data-hand={hand}>
      <header className="note-bar">
        <div className="note-bar-group note-title">
          <input
            value={notebook.title}
            aria-label={t('ノートの題名')}
            maxLength={60}
            readOnly={isTest}
            onChange={(e) => apply({ ...notebook, title: e.target.value })}
          />
          <span className="save-state" data-state={saveState}>
            {saveLabel}
          </span>
          {isDrill && vocab.data?.word && (
            <span className="drill-now">{tx('いまの言葉 {0}', <strong>{vocab.data.word.word}</strong>)}
            </span>
          )}
        </div>

        <div className="note-bar-group">
          <div className="segmented" aria-label={t('書き方')}>
            <button aria-pressed={!typing} onClick={() => setTyping(false)}>{t('手書き')}</button>
            <button aria-pressed={typing} onClick={() => setTyping(true)}>{t('タイピング')}</button>
          </div>
          {typing && (
            <MicButton
              lang={notebook.ruling.kind === 'english' ? 'en' : 'ja'}
              label={t('マイクで話して、いま開いているページに入力する')}
              onText={(text) => {
                const page = current.current?.pages[activePage]
                if (!page) return
                commitPage(activePage, { ...page, typed: `${page.typed ?? ''}${text}` })
                refresh()
              }}
            />
          )}
        </div>

        <div className="note-bar-group" role="toolbar" aria-label={t('道具')} data-dimmed={typing}>
          {TOOLS.map((t) => (
            <button key={t.id} className="tool" aria-pressed={tool === t.id} title={t.label} onClick={() => setTool(t.id)}>
              <Icon path={t.icon} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        {tool === 'select' && !typing && (
          <div className="note-bar-group">
            <div className="segmented" aria-label={t('範囲の囲み方')}>
              <button aria-pressed={region === 'rect'} onClick={() => setRegion('rect')}>{t('四角')}</button>
              <button aria-pressed={region === 'lasso'} onClick={() => setRegion('lasso')}>{t('投げなわ')}</button>
            </div>
          </div>
        )}

        {tool === 'shape' && (
          <div className="note-bar-group" aria-label={t('図形の種類')}>
            {SHAPES.map((s) => (
              <button key={s.kind} className="tool tool-small" aria-pressed={shapeKind === s.kind} title={s.label} aria-label={s.label} onClick={() => setShapeKind(s.kind)}>
                <Icon path={s.icon} />
              </button>
            ))}
          </div>
        )}

        {tool !== 'eraser' && tool !== 'select' && (
          <div className="note-bar-group" aria-label={t('色')}>
            {(tool === 'marker' ? MARKER_COLORS : PEN_COLORS).map((c) => (
              <button
                key={c.value}
                className="swatch"
                aria-pressed={color === c.value}
                aria-label={c.label}
                title={c.label}
                style={{ background: c.value }}
                onClick={() => (tool === 'marker' ? setMarkerColor(c.value) : setPenColor(c.value))}
              />
            ))}
          </div>
        )}

        {tool === 'eraser' && !typing && (
          <div className="note-bar-group" aria-label={t('消しゴムの大きさと消し方')}>
            {ERASER_SIZES.map((s) => (
              <button key={s.value} className="size size-eraser" aria-pressed={eraserSize === s.value} title={t('消しゴムの大きさ: {0}', s.label)} aria-label={t('消しゴムの大きさ: {0}', s.label)} onClick={() => setEraserSize(s.value)}>
                <i style={{ width: 6 + Math.sqrt(s.value) * 2, height: 6 + Math.sqrt(s.value) * 2 }} />
              </button>
            ))}
            <div className="segmented" aria-label={t('消し方')}>
              <button aria-pressed={!eraseWhole} title={t('消しゴムが通ったところだけを消します')} onClick={() => setEraseWhole(false)}>{t('部分')}</button>
              <button aria-pressed={eraseWhole} title={t('触れた線を、1 本まるごと消します')} onClick={() => setEraseWhole(true)}>{t('線ごと')}</button>
            </div>
          </div>
        )}

        {(tool === 'pen' || tool === 'shape') && (
          <div className="note-bar-group" aria-label={t('太さ')}>
            {PEN_SIZES.map((s) => (
              <button key={s.value} className="size" aria-pressed={penSize === s.value} title={s.label} aria-label={s.label} onClick={() => setPenSize(s.value)}>
                <i style={{ width: s.value * 1.1, height: s.value * 1.1 }} />
              </button>
            ))}
          </div>
        )}

        <div className="note-bar-group">
          <button className="tool" title={t('元に戻す（Ctrl + Z）')} disabled={!history.current.undo.length} onClick={undo}>
            <Icon path="M9 14L4 9l5-5 M4 9h10a6 6 0 010 12h-3" />
            <span>{t('戻す')}</span>
          </button>
          <button className="tool" title={t('やり直す（Ctrl + Y）')} disabled={!history.current.redo.length} onClick={redo}>
            <Icon path="M15 14l5-5-5-5 M20 9H10a6 6 0 000 12h3" />
            <span>{t('やり直す')}</span>
          </button>
        </div>

        <div className="note-bar-group popover-host">
          <button className="tool" aria-expanded={rulingOpen} onClick={() => setRulingOpen((open) => !open)}>
            <Icon path="M4 7h16 M4 12h16 M4 17h16" />
            <span>{t('罫線')}</span>
          </button>
          {rulingOpen && (
            <div className="popover" role="dialog" aria-label={t('罫線の設定')}>
              <p className="popover-title">{t('罫線の種類')}</p>
              <div className="segmented">
                {(
                  [
                    ['lined', t('横罫')],
                    ['grid', t('方眼')],
                    ['plain', t('無地')],
                    ['english', t('英語 4 線')],
                  ] as const
                ).map(([kind, label]) => (
                  <button key={kind} aria-pressed={notebook.ruling.kind === kind} onClick={() => changeRuling({ ...notebook.ruling, kind })}>
                    {label}
                  </button>
                ))}
              </div>
              <p className="popover-title">{t('間隔')}</p>
              <div className="segmented">
                {SPACINGS.map((spacing) => (
                  <button
                    key={spacing}
                    disabled={notebook.ruling.kind === 'plain'}
                    aria-pressed={notebook.ruling.spacing === spacing}
                    onClick={() => changeRuling({ ...notebook.ruling, spacing })}
                  >
                    {spacing}mm
                  </button>
                ))}
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!notebook.ruling.vertical}
                  disabled={notebook.ruling.kind !== 'lined'}
                  onChange={(e) => changeRuling({ ...notebook.ruling, vertical: e.target.checked })}
                />{t('縦書き（罫線を縦にする）')}</label>
              <button className="btn btn-quiet" onClick={() => setRulingOpen(false)}>{t('閉じる')}</button>
            </div>
          )}
        </div>

        <div className="note-bar-group popover-host">
          <button className="tool" aria-expanded={insertOpen} onClick={() => setInsertOpen((open) => !open)}>
            <Icon path="M12 5v14 M5 12h14" />
            <span>{t('挿入')}</span>
          </button>
          {insertOpen && (
            <div className="popover insert" role="dialog" aria-label={t('ページに入れるもの')}>
              <div className="insert-row">
                <strong>{t('表')}</strong>
                <select value={tableSize.rows} aria-label={t('行の数')} onChange={(e) => setTableSize({ ...tableSize, rows: Number(e.target.value) })}>
                  {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                    <option key={n} value={n}>
                      {tx('{0} 行', n)}</option>
                  ))}
                </select>
                <select value={tableSize.cols} aria-label={t('列の数')} onChange={(e) => setTableSize({ ...tableSize, cols: Number(e.target.value) })}>
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <option key={n} value={n}>
                      {tx('{0} 列', n)}</option>
                  ))}
                </select>
                <button className="btn" onClick={insertTable}>{t('表を入れる')}</button>
              </div>
              <div className="insert-row">
                <strong>{t('グラフ')}</strong>
                <select value={graphRange} aria-label={t('座標軸の範囲')} onChange={(e) => setGraphRange(Number(e.target.value))}>
                  <option value={5}>−5 〜 5</option>
                  <option value={10}>−10 〜 10</option>
                </select>
                <button className="btn" onClick={insertGraph}>{t('座標平面を入れる')}</button>
              </div>
              <div className="insert-row">
                <strong>{t('ファイル')}</strong>
                <button className="btn" onClick={() => void insertImage()}>{t('画像を選ぶ')}</button>
                <button className="btn" onClick={() => void insertVideo()}>{t('動画を選ぶ')}</button>
              </div>
              <div className="insert-row">
                <strong>{t('リンク')}</strong>
                <input type="text" value={link.url} placeholder="https://…" spellCheck={false} aria-label={t('リンクのアドレス')} onChange={(e) => setLink({ ...link, url: e.target.value })} />
                <input type="text" value={link.title} placeholder={t('見出し（省略できます）')} aria-label={t('リンクの見出し')} onChange={(e) => setLink({ ...link, title: e.target.value })} />
                <button className="btn" disabled={!link.url.trim()} onClick={insertLink}>{t('入れる')}</button>
              </div>
              <p className="muted">{t('入れたものは「選択」で動かしたり、大きさを変えたり、消したりできます。その上にペンで書きこむこともできます。')}</p>
              <button className="btn btn-quiet" onClick={() => setInsertOpen(false)}>{t('閉じる')}</button>
            </div>
          )}
        </div>

        <span className="note-bar-spacer" />

        <div className="note-bar-group">
          {!isTest && (
            <button className="tool" aria-pressed={panel === 'transcript'} title={t('手書きの文字を、AI に文字へ起こしてもらう（評価はしません）')} onClick={() => togglePanel('transcript')}>
              <Icon path="M4 6h9 M4 11h6 M4 16h4 M14 19l1-4 6-6 3 3-6 6-4 1z" />
              <span>{t('文字起こし')}</span>
            </button>
          )}
          <button className="tool" aria-pressed={panel === 'search'} onClick={() => togglePanel('search')}>
            <Icon path="M11 18a7 7 0 100-14 7 7 0 000 14z M20 20l-4-4" />
            <span>{t('検索')}</span>
          </button>
          <button className="tool" aria-pressed={panel === 'pen'} onClick={() => togglePanel('pen')}>
            <Icon path="M3 12h3l3-7 4 14 3-7h5" />
            <span>{t('ペン診断')}</span>
          </button>
          <button className="tool" onClick={() => void exportPdf()}>
            <Icon path="M12 4v11 M7 11l5 5 5-5 M5 20h14" />
            <span>PDF</span>
          </button>
          {!isTest && <PinButton className="tool" />}
          {isDrill && (
            <button className="btn btn-primary" disabled={checking || !vocab.data?.word} onClick={() => void checkDrill()}>
              {checking ? t('確かめています…') : t('書けた！')}
            </button>
          )}
          {!isTest && !isDrill && !isMemo && (
            <button className="btn btn-primary" aria-pressed={panel === 'evaluation'} onClick={() => (panel === 'evaluation' ? void evaluate() : setPanel('evaluation'))}>
              {tx('{0}に見てもらう', teacher?.name ?? t('先生'))}</button>
          )}
        </div>
      </header>

      <div className="note-body">
        <main className="note-stage-wrap">
          <div className="note-stage" ref={stageRef} data-gesture={gesture ?? undefined} onPointerDownCapture={startGesture}>
            <div
              className="spread"
              style={{ '--zoom': zoom, transform: `translate(${pan.x}px, ${pan.y}px)${preview ? ` scale(${preview.scale})` : ''}`, transformOrigin: preview?.origin } as CSSProperties}
            >
              {shownPages.map((index) =>
                notebook.pages[index] ? (
                  <PageSurface
                    key={notebook.pages[index].id}
                    page={notebook.pages[index]}
                    pageNumber={index + 1}
                    ruling={notebook.ruling}
                    tool={tool}
                    color={color}
                    size={size}
                    eraser={{ radius: eraserSize, whole: eraseWhole }}
                    shapeKind={shapeKind}
                    region={region}
                    typing={typing}
                    touch={phone}
                    locked={gesture !== null}
                    onActivate={() => setActivePage(index)}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onCommit={(next) => {
                      commitPage(index, next)
                      refresh()
                    }}
                    onNotice={(text) => show(text, 'error')}
                  />
                ) : (
                  <div key={index} className="note-page note-page-missing" />
                ),
              )}
            </div>
          </div>

          <footer className="pager">
            <button className="btn" disabled={single === 0} onClick={() => turnPage(-1)}>{t('‹ 前へ')}</button>
            <span className="pager-now">{tx('{0} / {1} ページ', single + 1, notebook.pages.length)}</span>
            <button className="btn" disabled={single >= notebook.pages.length - 1} onClick={() => turnPage(1)}>{t('次へ ›')}</button>
            <form
              className="pager-jump"
              onSubmit={(e) => {
                e.preventDefault()
                goToPage(Number(jump))
                setJump('')
              }}
            >
              <input type="number" min={1} max={notebook.pages.length} value={jump} placeholder={t('ページ')} aria-label={t('移動先のページ番号')} onChange={(e) => setJump(e.target.value)} />
              <button className="btn" type="submit" disabled={!jump}>{t('移動')}</button>
            </form>
            <button className="btn" onClick={addSpread}>{t('＋ ページを追加')}</button>
            {(pan.x !== 0 || pan.y !== 0) && (
              <button className="btn" onClick={() => setPan({ x: 0, y: 0 })}>{t('位置をもどす')}</button>
            )}
            <span className="pager-spacer" />
            <div className="page-zoom">
              <button className="btn" disabled={zoom <= 1} aria-label={t('ページを小さくする')} onClick={() => zoomTo(zoom - 0.25)}>
                −
              </button>
              <input type="range" min={100} max={400} step={5} value={Math.round(zoom * 100)} aria-label={t('ページの拡大率')} onChange={(e) => zoomTo(Number(e.target.value) / 100)} />
              <button className="btn" disabled={zoom >= 4} aria-label={t('ページを大きくする')} onClick={() => zoomTo(zoom + 0.25)}>
                ＋
              </button>
              <button className="btn page-zoom-value" title={t('ページの幅がちょうど収まる大きさ（100%）にもどす')} onClick={() => zoomTo(1)}>
                {Math.round(zoom * 100)}%
              </button>
            </div>
          </footer>
        </main>

        {panel && (
          <aside className="note-panel">
            <header>
              <strong>{{ evaluation: t('ノートの評価'), transcript: t('手書きの文字起こし'), search: t('ノート内を検索'), pen: t('ペンの診断') }[panel]}</strong>
              <button className="btn btn-quiet" onClick={() => setPanel(null)} aria-label={t('パネルを閉じる')}>{t('閉じる')}</button>
            </header>
            <div className="note-panel-body">
              {panel === 'transcript' && (
                <TranscriptPanel
                  pages={shownPages.filter((i) => notebook.pages[i]).map((index) => ({ index, page: notebook.pages[index] }))}
                  inkPages={notebook.pages.filter((page) => page.strokes.length).length}
                  busy={transcribing}
                  error={transcribeError}
                  onRun={(scope) => void transcribe(scope)}
                  onEdit={(index, text) => replacePage(index, { ...current.current!.pages[index], transcript: text })}
                  onInsert={insertTranscript}
                />
              )}
              {panel === 'evaluation' && !isTest && !isDrill && !isMemo && (
                <EvaluationPanel
                  teacher={teacher}
                  evaluations={evaluations.data ?? []}
                  evaluating={evaluating}
                  error={evaluationError}
                  onEvaluate={() => void evaluate()}
                />
              )}
              {panel === 'pen' && <PenDiagnostics />}
              {panel === 'search' && (
                <div className="search">
                  <input autoFocus type="search" value={query} placeholder={t('探したい言葉')} onChange={(e) => setQuery(e.target.value)} />
                  {query.trim() && <p className="muted">{results.length ? t('{0} 件見つかりました', results.length) : t('見つかりませんでした')}</p>}
                  <ul>
                    {results.map((r, i) => (
                      <li key={i}>
                        <button onClick={() => goToPage(r.page)}>
                          <strong>p.{r.page}</strong>
                          <small>{r.kind}</small>
                          <span>{r.snippet}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <p className="muted">{t('キーボードで入力した文字はすぐに検索できます。手書きの文字は、「文字起こし」をすると検索できるようになります。')}</p>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {toast && (
        <p className="toast" data-kind={toast.kind} role="status">
          {toast.text}
        </p>
      )}
    </div>
  )
}
