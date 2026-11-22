import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { KANJI_BOX, KANJI_TIMES, copyProgress } from '@shared/kanji'
import type { NotePage, Ruling } from '@shared/types'
import { MicButton } from '../components/MicButton'
import { api, errorMessage, useLoad, useToast, usePhone, useNoTouchScroll } from '../lib/hooks'
import { judgeStroke, samplePath, type Point } from '../lib/kanjiStroke'
import { PageSurface, type Tool } from '../note/PageSurface'
import { t } from '@/lib/i18n'
import { newId } from '../lib/id'

/** はじめの何マスに、なぞるための手本をうすく出すか */
const TRACE_BOXES = 2
const COPY_RULING: Ruling = { kind: 'lined', spacing: 10 }
const INK = '#23232b'
const blankPage = (): NotePage => ({ id: newId(), strokes: [], texts: [], typed: '' })
const emptyBoxes = (): Point[][][] => Array.from({ length: KANJI_TIMES }, () => [])

const MESSAGES = {
  order: (n: number) => t('書き順がちがいます。{0} 画目は、青い線のところです。', n),
  direction: (n: number) => t('{0} 画目は、向きが逆です。青い線の、丸いしるしのほうから書きはじめましょう。', n),
  shape: (n: number) => t('形か位置がちがうようです。{0} 画目を、もう一度書いてみましょう。', n),
}

/**
 * 漢字特訓モード（3 つ目のウィンドウ）。書きこむノート。
 *   左のページ … 10 個のマス。正しい書き順で書けた線だけが残る（ちがう線は消えて、手がかりが出る）
 *   右のページ … 単語と例文を書き写す（手書きでも、タイピングでもよい）
 * 両方ができると「書けた！」で次の漢字へ進む。
 */
export function KanjiNote() {
  const phone = usePhone()
  const state = useLoad(() => api.kanji.state(), [], ['kanji'])
  const entry = state.data?.entry ?? null
  const words = state.data?.words ?? null
  const [boxes, setBoxes] = useState<Point[][][]>(emptyBoxes)
  /** まちがえた線（少しのあいだ赤く見せる）と、手がかりとして見せる画 */
  const [miss, setMiss] = useState<Point[] | null>(null)
  const [hint, setHint] = useState<number | null>(null)
  const [misses, setMisses] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [traceAll, setTraceAll] = useState(false)
  const [page, setPage] = useState<NotePage>(blankPage)
  const history = useRef<NotePage[]>([])
  const [tool, setTool] = useState<Tool>('pen')
  const [typing, setTyping] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const missTimer = useRef<number>(undefined)
  const { toast, show } = useToast()

  const expected = useMemo(() => (entry?.strokes ?? []).map((d) => samplePath(d)), [entry?.char])
  const strokeCount = expected.length

  // 字が変わったら、マスも右のページも新しくする
  useEffect(() => {
    setBoxes(emptyBoxes())
    setPage(blankPage())
    history.current = []
    setMiss(null)
    setHint(null)
    setMisses(0)
    setMessage(null)
  }, [entry?.char])

  const done = strokeCount ? boxes.filter((box) => box.length >= strokeCount).length : 0
  const active = strokeCount ? boxes.findIndex((box) => box.length < strokeCount) : -1

  // 書けた回数を、漢字のウィンドウにも知らせる
  useEffect(() => {
    if (entry) void api.kanji.written(done)
  }, [done, entry?.char])

  if (!state.data) return null
  if (!entry) {
    return (
      <div className="kanji-note">
        <p className="view-error">{t('漢字特訓を始めると、ここに書きこむマスが出ます。')}</p>
      </div>
    )
  }

  const draw = (points: Point[]) => {
    if (active < 0) return
    const index = boxes[active].length
    const verdict = judgeStroke(points, expected, index)
    window.clearTimeout(missTimer.current)
    if (verdict.ok) {
      setBoxes((all) => all.map((box, i) => (i === active ? [...box, points] : box)))
      setMiss(null)
      setHint(null)
      setMisses(0)
      setMessage(null)
      return
    }
    setMiss(points)
    missTimer.current = window.setTimeout(() => setMiss(null), 700)
    setMisses(misses + 1)
    setMessage(MESSAGES[verdict.reason](index + 1))
    // 書き順と向きのまちがいは、すぐに手がかりを見せる。形のまちがいは、2 回続いたら見せる
    if (verdict.reason !== 'shape' || misses >= 1) setHint(index)
  }

  const redo = () => {
    if (active < 0) return
    setBoxes((all) => all.map((box, i) => (i === active ? [] : box)))
    setHint(null)
    setMisses(0)
    setMessage(null)
  }

  const commit = (next: NotePage) => {
    history.current.push(page)
    setPage(next)
  }
  const undo = () => {
    const previous = history.current.pop()
    if (previous) setPage(previous)
  }

  const typed = `${page.typed ?? ''}\n${page.texts.map((t) => t.text).join('\n')}`
  const hasTargets = !!words && words.words.length + words.sentences.length > 0
  const copied = hasTargets ? copyProgress(words, page.strokes.length, typed) : 1
  const ready = done >= KANJI_TIMES && (copied >= 1 || !words)

  const finish = async () => {
    if (!ready || finishing) return
    setFinishing(true)
    try {
      await api.kanji.clear()
      show(t('「{0}」をクリアしました。漢字力が上がりました。', entry.char))
    } catch (e) {
      show(errorMessage(e), 'error')
    } finally {
      setFinishing(false)
    }
  }

  const stage =
    done < KANJI_TIMES
      ? t('「{0}」を、正しい書き順で {1} 回書く（{2} / {3}）', entry.char, KANJI_TIMES, done, KANJI_TIMES)
      : hasTargets && copied < 1
        ? t('言葉と例文を、右のページに書き写す（{0}%）', Math.round(copied * 100))
        : t('書けました。「書けた！」で次の漢字へ進みます')

  return (
    <div className="kanji-note">
      <header className="note-bar kanji-note-bar">
        <div className="note-bar-group kanji-note-title">
          <strong lang="ja">{entry.char}</strong>
          <span>{stage}</span>
        </div>
        <span className="note-bar-spacer" />
        <div className="note-bar-group">
          <div className="segmented" aria-label={t('右のページの書き方')}>
            <button aria-pressed={!typing} onClick={() => setTyping(false)}>{t('手書き')}</button>
            <button aria-pressed={typing} onClick={() => setTyping(true)}>{t('タイピング')}</button>
          </div>
          {typing && <MicButton label={t('マイクで話して、右のページに入力する')} onText={(text) => commit({ ...page, typed: `${page.typed ?? ''}${text}` })} />}
        </div>
        <div className="note-bar-group" data-dimmed={typing}>
          <button className="btn" aria-pressed={tool === 'pen'} onClick={() => setTool('pen')}>{t('ペン')}</button>
          <button className="btn" aria-pressed={tool === 'eraser'} onClick={() => setTool('eraser')}>{t('消しゴム')}</button>
        </div>
        <div className="note-bar-group">
          <button className="btn" disabled={!history.current.length} onClick={undo}>{t('戻す')}</button>
          <button className="btn btn-primary" disabled={!ready || finishing} onClick={() => void finish()}>{t('書けた！')}</button>
        </div>
      </header>

      <div className="kanji-note-stage">
        <div className="kanji-spread">
          <section className="kanji-grid-page" aria-label={t('漢字を書くマス')}>
            <div className="kanji-grid">
              {boxes.map((strokes, i) => (
                <KanjiBox
                  key={i}
                  number={i + 1}
                  strokes={strokes}
                  paths={entry.strokes}
                  status={i === active ? 'active' : strokes.length >= strokeCount ? 'done' : 'pending'}
                  trace={traceAll || i < TRACE_BOXES}
                  miss={i === active ? miss : null}
                  hint={i === active ? hint : null}
                  onDraw={draw}
                />
              ))}
              <div className="kanji-grid-side">
                <p className="kanji-message" role="status" data-kind={message ? 'miss' : 'info'}>
                  {message ?? (done >= KANJI_TIMES ? t('{0} 回、正しい書き順で書けました。', KANJI_TIMES) : t('{0} 画目を書きましょう。書き順は「書き順」のウィンドウで確かめられます。', Math.max(1, (boxes[active]?.length ?? 0) + 1)))}
                </p>
                <button className="btn" disabled={active < 0 || !boxes[active]?.length} onClick={redo}>{t('このマスを書き直す')}</button>
                <label className="check">
                  <input type="checkbox" checked={traceAll} onChange={(e) => setTraceAll(e.target.checked)} />{t('すべてのマスに手本をうすく出す')}</label>
              </div>
            </div>
          </section>

          <PageSurface
            page={page}
            pageNumber={2}
            ruling={COPY_RULING}
            tool={tool}
            color={INK}
            size={9}
            eraser={{ radius: 25, whole: false }}
            touch={phone}
            shapeKind="line"
            region="rect"
            typing={typing}
            locked={false}
            selectedId={null}
            onSelect={() => {}}
            onActivate={() => {}}
            onCommit={commit}
            onNotice={(text) => show(text, 'error')}
          />
        </div>
      </div>

      {toast && (
        <p className="toast" data-kind={toast.kind} role="status">
          {toast.text}
        </p>
      )}
    </div>
  )
}

// ───────── 1 マス ─────────

function trace(ctx: CanvasRenderingContext2D, points: Point[]): void {
  ctx.beginPath()
  ctx.moveTo(points[0][0], points[0][1])
  for (let i = 1; i < points.length - 1; i++) {
    // 点と点の中間を通る曲線にして、なめらかに見せる
    const mid: Point = [(points[i][0] + points[i + 1][0]) / 2, (points[i][1] + points[i + 1][1]) / 2]
    ctx.quadraticCurveTo(points[i][0], points[i][1], mid[0], mid[1])
  }
  const last = points[points.length - 1]
  ctx.lineTo(last[0], last[1])
  ctx.stroke()
}

function KanjiBox({
  number,
  strokes,
  paths,
  status,
  trace: showModel,
  miss,
  hint,
  onDraw,
}: {
  number: number
  /** 正しく書けた線（枠 109 の座標） */
  strokes: Point[][]
  /** 手本の線 */
  paths: string[]
  status: 'active' | 'done' | 'pending'
  /** なぞるための手本を、うすく出すか */
  trace: boolean
  miss: Point[] | null
  hint: number | null
  onDraw: (points: Point[]) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // 指で書くとき、なぞっても画面が動かないようにする（iPhone の Safari 向け）
  useNoTouchScroll(canvasRef, status === 'active')
  const live = useRef<{ pointerId: number; points: Point[] } | null>(null)
  const [size, setSize] = useState(0)

  useEffect(() => {
    const canvas = canvasRef.current!
    const measure = () => setSize(canvas.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  const paint = () => {
    const canvas = canvasRef.current
    if (!canvas || !size) return
    const pixels = Math.round(size * (window.devicePixelRatio || 1))
    if (canvas.width !== pixels) canvas.width = canvas.height = pixels
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(pixels / KANJI_BOX, 0, 0, pixels / KANJI_BOX, 0, 0)
    ctx.clearRect(0, 0, KANJI_BOX, KANJI_BOX)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // 十字の目安の線
    ctx.strokeStyle = '#d9dfe8'
    ctx.lineWidth = 0.5
    ctx.setLineDash([2.5, 2.5])
    ctx.beginPath()
    ctx.moveTo(KANJI_BOX / 2, 2)
    ctx.lineTo(KANJI_BOX / 2, KANJI_BOX - 2)
    ctx.moveTo(2, KANJI_BOX / 2)
    ctx.lineTo(KANJI_BOX - 2, KANJI_BOX / 2)
    ctx.stroke()
    ctx.setLineDash([])

    if (showModel && status !== 'done') {
      ctx.strokeStyle = '#dcdce4'
      ctx.lineWidth = 4.2
      for (const d of paths) ctx.stroke(new Path2D(d))
    }
    if (hint !== null && paths[hint]) {
      // 手がかり: 次に書く画を青く見せ、書きはじめに丸いしるしを付ける
      ctx.strokeStyle = 'rgba(46, 120, 196, 0.55)'
      ctx.lineWidth = 5
      ctx.stroke(new Path2D(paths[hint]))
      const [x, y] = samplePath(paths[hint], 2)[0]
      ctx.fillStyle = '#2e78c4'
      ctx.beginPath()
      ctx.arc(x, y, 3.4, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.strokeStyle = status === 'done' ? '#2c6b45' : '#23232b'
    ctx.lineWidth = 4.4
    for (const points of strokes) trace(ctx, points)
    if (miss) {
      ctx.strokeStyle = '#c8452f'
      trace(ctx, miss)
    }
    if (live.current && live.current.points.length > 1) {
      ctx.strokeStyle = '#23232b'
      trace(ctx, live.current.points)
    }
  }
  useEffect(paint)

  const at = (e: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect()
    return [((e.clientX - rect.left) / rect.width) * KANJI_BOX, ((e.clientY - rect.top) / rect.height) * KANJI_BOX]
  }

  return (
    <div className="kanji-box" data-status={status}>
      <span className="kanji-box-number">{status === 'done' ? '✓' : number}</span>
      <canvas
        ref={canvasRef}
        onPointerDown={(e) => {
          if (status !== 'active' || (e.pointerType === 'mouse' && e.button !== 0)) return
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            // つかめなくても、マスの中で書くぶんには困らない
          }
          live.current = { pointerId: e.pointerId, points: [at(e)] }
        }}
        onPointerMove={(e) => {
          if (live.current?.pointerId !== e.pointerId) return
          // ペンは 1 回の通知に複数の座標をまとめて届けるので、すべて拾う
          const events = e.nativeEvent.getCoalescedEvents?.() ?? []
          const rect = e.currentTarget.getBoundingClientRect()
          for (const ev of events.length ? events : [e.nativeEvent]) {
            live.current.points.push([((ev.clientX - rect.left) / rect.width) * KANJI_BOX, ((ev.clientY - rect.top) / rect.height) * KANJI_BOX])
          }
          paint()
        }}
        onPointerUp={(e) => {
          if (live.current?.pointerId !== e.pointerId) return
          const points = live.current.points
          live.current = null
          if (points.length === 1) points.push([points[0][0] + 0.5, points[0][1] + 0.5])
          onDraw(points)
        }}
        onPointerCancel={() => {
          live.current = null
          paint()
        }}
      />
    </div>
  )
}
