import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SIMS, parseSim } from '@shared/sims'
import type { CharacterDef, ViewParams } from '@shared/types'
import { simValuesAt, videoLines, type VideoInfo, type VideoProgress, type VideoScene } from '@shared/video'
import { Markdown } from '../components/Markdown'
import { characterImage } from '../components/Portrait'
import { SIM_VIEWS } from '../components/SimViews'
import { api, errorMessage, useLoad } from '../lib/hooks'
import { t, tx } from '@/lib/i18n'

/**
 * 授業の動画（試作）。台本（場面とせりふ）と、せりふごとの音声を合わせて再生する。
 *
 * 画面は、いつも横 1280 × 縦 720 の大きさで組み、ウィンドウに合わせて全体を拡大・縮小する
 * （動画ファイルに書き出すときに、どの PC でも同じ絵になるように）。
 * 書き出しは、再生している画面と音をそのまま録画して、メインプロセスに渡す。
 */

const W = 1280
const H = 720
/** せりふとせりふの間、場面が変わるときの間（ミリ秒） */
const GAP = 260
const SCENE_GAP = 650

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
const render = (text: string) => <Markdown>{text}</Markdown>

export function Video({ params }: { params: ViewParams }) {
  const lessonId = params.lessonId ?? ''
  const variant = params.variant
  const video = useLoad(() => (lessonId ? api.video.get(lessonId, variant) : Promise.resolve(null)), [lessonId, variant], ['video', 'content'])
  const voice = useLoad(() => api.video.voice(), [], [])
  const characters = useLoad(() => api.characters.list(), [], ['characters'])
  const [progress, setProgress] = useState<VideoProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => api.video.onProgress(setProgress), [])
  useEffect(() => {
    if (lessonId) void api.view.context({ lessonId })
  }, [lessonId])

  const make = async (redo: boolean) => {
    setBusy(true)
    setError(null)
    try {
      video.setData(await api.video.make(lessonId, variant, redo))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const info = video.data
  const making = busy && (
    <p className="video-making" role="status">
      {progress?.step === 'voice' ? t('声を作っています…（{0} / {1}）', progress.done, progress.total) : progress?.step === 'reading' ? t('読み上げの読みまちがいが無いか、確かめています…') : t('台本を書いています…（1〜2 分かかります）')}
    </p>
  )

  if (info && info.durations.length > 0 && characters.data) {
    return <Player key={`${info.lessonId}:${info.variant}:${info.durations.length}`} info={info} characters={characters.data} busy={busy} status={making} error={error} onRedo={() => void make(true)} onSaved={() => video.reload()} />
  }
  return (
    <div className="video-view">
      <header className="view-header" data-mode="textbook">
        <div className="view-header-title">
          <small>{info ? info.courseTitle : t('動画（試作）')}</small>
          <strong>{info ? info.title : t('授業の動画')}</strong>
        </div>
      </header>
      <div className="video-empty">
        {video.data === undefined || !characters.data ? (
          <p className="muted">{t('読みこんでいます…')}</p>
        ) : (
          <>
            <h2>{info ? t('この動画には、まだ声がありません') : t('この授業の動画は、まだありません')}</h2>
            <p>{t('授業の本文をもとに、AI が 3〜5 分の動画の台本を書き、読み上げソフトが声を付けます。画面は、アプリが台本から描きます（試作の機能です）。')}</p>
            {voice.data && !voice.data.ready && <p className="form-error">{t('読み上げソフト（AivisSpeech）が動いていません。AivisSpeech を起動してから、下のボタンを押してください。')}</p>}
            {making || (
              <button className="btn btn-primary" disabled={!lessonId || busy} onClick={() => void make(false)}>
                {info ? t('声を付ける') : t('AI に動画を作ってもらう')}
              </button>
            )}
            {error && <p className="form-error">{error}</p>}
          </>
        )}
      </div>
    </div>
  )
}

function Player({
  info,
  characters,
  busy,
  status,
  error,
  onRedo,
  onSaved,
}: {
  info: VideoInfo
  characters: CharacterDef[]
  busy: boolean
  status: React.ReactNode
  error: string | null
  onRedo: () => void
  onSaved: () => void
}) {
  const lines = useMemo(() => videoLines(info.script), [info.script])
  const sim = useMemo(() => parseSim(info.sim), [info.sim])
  const starts = useMemo(() => {
    // せりふごとの、始まる時刻（秒）。間もふくめて数える
    let at = 0.4
    return lines.map((line, i) => {
      if (i > 0) at += info.durations[i - 1] + (line.scene !== lines[i - 1].scene ? SCENE_GAP : GAP) / 1000
      return at
    })
  }, [lines, info.durations])
  const total = starts[starts.length - 1] + info.durations[info.durations.length - 1] + 0.8

  const [cursor, setCursor] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [recording, setRecording] = useState(false)
  const [audios, setAudios] = useState<string[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const audioRef = useRef<HTMLAudioElement>(null)
  const token = useRef(0)

  // せりふの音声を、はじめに全部読みこんでおく（再生の途中で待たせないため）
  useEffect(() => {
    let cancelled = false
    void Promise.all(lines.map((_line, i) => api.video.audio(info.lessonId, info.variant, i))).then((list) => !cancelled && setAudios(list))
    return () => {
      cancelled = true
      token.current += 1
    }
  }, [info, lines])

  const stop = useCallback(() => {
    token.current += 1
    audioRef.current?.pause()
    setPlaying(false)
  }, [])

  /** from 番目のせりふから、最後まで順に再生する。止められずに最後まで行ったら true */
  const play = useCallback(
    async (from: number): Promise<boolean> => {
      const audio = audioRef.current
      if (!audio || !audios) return false
      const mine = ++token.current
      setPlaying(true)
      for (let i = from; i < lines.length; i++) {
        setCursor(i)
        // 場面が変わった直後は、画面を見る間をおいてから話しはじめる
        if (i === from || lines[i].scene !== lines[i - 1].scene) await wait(i === from ? 300 : SCENE_GAP)
        else await wait(GAP)
        if (mine !== token.current) return false
        audio.src = audios[i]
        await new Promise<void>((resolve) => {
          audio.onended = audio.onerror = () => resolve()
          audio.play().catch(() => resolve())
        })
        if (mine !== token.current) return false
      }
      await wait(800)
      if (mine !== token.current) return false
      setPlaying(false)
      return true
    },
    [audios, lines],
  )

  // 再生している時刻（進み具合の表示用）
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => setElapsed(starts[cursor] + (audioRef.current?.currentTime ?? 0)), 200)
    return () => window.clearInterval(timer)
  }, [playing, cursor, starts])
  useEffect(() => {
    if (!playing) setElapsed(starts[cursor])
  }, [cursor, playing, starts])

  /** 再生している画面と音を録画して、動画ファイルに書き出す */
  const record = async () => {
    stop()
    setFailed(null)
    setMessage(null)
    let stream: MediaStream | null = null
    let started = false
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true })
      const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type))
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 160_000 })
      await api.video.record(info.lessonId, info.variant, 'start')
      started = true
      // 録画したデータは、できた順に少しずつメインプロセスへ渡す
      let sending = Promise.resolve()
      recorder.ondataavailable = (event) => {
        if (event.data.size) sending = sending.then(async () => void (await api.video.record(info.lessonId, info.variant, 'chunk', await event.data.arrayBuffer())))
      }
      const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()))
      setCursor(0)
      setRecording(true)
      await wait(700) // 画面が録画用の大きさに切りかわるのを待つ
      recorder.start(1000)
      await wait(500)
      const finished = await play(0)
      await wait(400)
      recorder.stop()
      await stopped
      await sending
      if (!finished) throw new Error(t('録画を途中でやめました。'))
      const file = await api.video.record(info.lessonId, info.variant, 'end')
      started = false
      setMessage(t('動画ファイルに書き出しました: {0}', file))
      onSaved()
    } catch (e) {
      setFailed(errorMessage(e))
      if (started) void api.video.record(info.lessonId, info.variant, 'cancel')
    } finally {
      stream?.getTracks().forEach((track) => track.stop())
      setRecording(false)
      setPlaying(false)
    }
  }

  // 録画のあいだは、画面いっぱいに動画だけを出す
  useEffect(() => {
    if (recording) document.body.dataset['recording'] = '1'
    else delete document.body.dataset['recording']
    return () => void delete document.body.dataset['recording']
  }, [recording])

  const current = lines[cursor]
  const scene = info.script.scenes[current.scene]
  const sceneStart = (index: number) => lines.findIndex((line) => line.scene === index)
  const jump = (index: number) => {
    const next = Math.max(0, Math.min(lines.length - 1, index))
    if (playing) void play(next)
    else setCursor(next)
  }

  return (
    <div className="video-view">
      <header className="view-header" data-mode="textbook">
        <div className="view-header-title">
          <small>{tx('{0} ／ 動画（試作）', info.courseTitle)}</small>
          <strong>{info.title}</strong>
        </div>
        <div className="view-header-actions">
          <button className="btn btn-mode" data-mode="textbook" onClick={() => void api.view.open('textbook', { lessonId: info.lessonId, variant: info.variant })}>{t('教科書で読む')}</button>
        </div>
      </header>

      <Stage info={info} characters={characters} scene={scene} sceneIndex={current.scene} lineIndex={current.line} cursor={cursor} sim={sim} seconds={info.durations[cursor]} />
      <audio ref={audioRef} preload="auto" />

      <div className="video-controls">
        <button className="btn btn-primary video-play" disabled={!audios || recording} onClick={() => (playing ? stop() : void play(cursor >= lines.length - 1 && !playing ? 0 : cursor))}>
          {!audios ? t('読みこんでいます…') : playing ? t('止める') : cursor > 0 && cursor < lines.length - 1 ? t('続きから再生') : t('再生')}
        </button>
        <button className="btn" disabled={recording || current.scene === 0} onClick={() => jump(sceneStart(current.scene - 1))}>{t('前の場面')}</button>
        <button className="btn" disabled={recording || current.scene >= info.script.scenes.length - 1} onClick={() => jump(sceneStart(current.scene + 1))}>{t('次の場面')}</button>
        <input className="video-seek" type="range" aria-label={t('再生する位置')} min={0} max={lines.length - 1} value={cursor} disabled={recording} onChange={(e) => jump(Number(e.target.value))} />
        <span className="video-time">
          {clock(elapsed)} / {clock(total)}
        </span>
      </div>
      <div className="video-actions">
        <button className="btn" disabled={!audios || recording || busy} title={t('動画を最初から最後まで再生しながら録画します。終わるまで、このウィンドウをそのままにしておいてください')} onClick={() => void record()}>{tx('動画ファイルに書き出す（{0} かかります）', clock(total))}</button>
        {info.file && (
          <button className="btn btn-quiet" onClick={() => void api.video.reveal(info.lessonId, info.variant)}>{t('書き出した動画のフォルダを開く')}</button>
        )}
        <button className="btn btn-quiet" disabled={busy || recording} title={t('AI に、台本から書き直してもらいます')} onClick={onRedo}>{t('台本から作り直す')}</button>
        <span className="muted video-credit">{tx('声: {0}　台本: AI が授業の本文から作成', info.voice)}</span>
      </div>
      {status}
      {message && <p className="muted video-note" data-export="done">{message}</p>}
      {(failed || error) && <p className="form-error video-note" data-export="failed">{failed || error}</p>}
    </div>
  )
}

/** 動画の画面 1 枚（横 1280 × 縦 720 で組んで、入れ物に合わせて拡大・縮小する） */
function Stage({
  info,
  characters,
  scene,
  sceneIndex,
  lineIndex,
  cursor,
  sim,
  seconds,
}: {
  info: VideoInfo
  characters: CharacterDef[]
  scene: VideoScene
  sceneIndex: number
  lineIndex: number
  cursor: number
  sim: ReturnType<typeof parseSim>
  seconds: number
}) {
  const frame = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.5)
  useLayoutEffect(() => {
    const element = frame.current
    if (!element) return
    const fit = () => setScale(Math.max(0.1, Math.min(element.clientWidth / W, element.clientHeight / H)))
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const line = scene.lines[lineIndex]
  const find = (id: string) => characters.find((c) => c.id === id)
  const speakers = useMemo(() => {
    const ids = [...new Set(info.script.scenes.flatMap((s) => s.lines.map((l) => l.speaker)))]
    const people = ids.map(find).filter((c): c is CharacterDef => !!c)
    return [...people.filter((c) => c.role === 'teacher'), ...people.filter((c) => c.role !== 'teacher')]
  }, [info.script, characters])
  // 話していない人は、最後に話したときの表情のままにする
  const faces = useMemo(() => {
    const last: Record<string, string> = {}
    for (const entry of videoLines(info.script).slice(0, cursor + 1)) last[entry.data.speaker] = entry.data.expression
    return last
  }, [info.script, cursor])
  const speaker = find(line.speaker)

  return (
    <div className="video-frame" ref={frame}>
      <div className="video-stage" data-kind={scene.kind} style={{ transform: `scale(${scale})`, marginRight: (scale - 1) * W, marginBottom: (scale - 1) * H }}>
        <div className="vs-head">
          <strong>{scene.kind === 'title' ? info.courseTitle : scene.heading}</strong>
          <span className="vs-dots" aria-hidden>
            {info.script.scenes.map((_s, i) => (
              <i key={i} data-on={i <= sceneIndex} />
            ))}
          </span>
        </div>

        <div className="vs-main" key={sceneIndex}>
          {scene.kind === 'title' && (
            <div className="vs-title">
              <small>{info.title.split(' ')[0]}</small>
              <h1>{scene.heading || info.title.split(' ').slice(1).join(' ')}</h1>
              {scene.items[0] && <p>{scene.items[0]}</p>}
            </div>
          )}
          {scene.kind === 'board' && (
            <ol className="vs-board">
              {scene.items.map((item, i) => (
                <li key={i} data-shown={i < line.show} data-new={i === line.show - 1 && (lineIndex === 0 || scene.lines[lineIndex - 1].show < line.show)}>
                  <Markdown>{item}</Markdown>
                </li>
              ))}
            </ol>
          )}
          {scene.kind === 'figure' && (
            <div className="vs-figure">
              <Markdown>{info.figures[Number(scene.ref) - 1] ?? ''}</Markdown>
            </div>
          )}
          {scene.kind === 'picture' && (
            <div className="vs-figure">
              <Markdown>{'```picture\n' + JSON.stringify({ id: scene.ref, caption: scene.heading }) + '\n```'}</Markdown>
            </div>
          )}
          {scene.kind === 'sim' && sim && <SimStage info={info} sim={sim} sceneIndex={sceneIndex} lineIndex={lineIndex} seconds={seconds} />}
        </div>

        <div className="vs-people">
          {speakers.map((c) => (
            <figure key={c.id} data-role={c.role} data-speaking={c.id === line.speaker}>
              <img src={characterImage(c, faces[c.id] || undefined)} alt="" draggable={false} />
              <figcaption>{c.role === 'teacher' ? c.name : (c.name.split(/[\s　]+/).pop() ?? c.name)}</figcaption>
            </figure>
          ))}
        </div>

        <div className="vs-caption" data-role={speaker?.role ?? 'teacher'} key={`c${cursor}`}>
          <Markdown>{line.text}</Markdown>
        </div>
      </div>
    </div>
  )
}

/** 動く図解の場面。せりふが変わるたびに、そのせりふで決めた値まで、なめらかに動かす */
function SimStage({ info, sim, sceneIndex, lineIndex, seconds }: { info: VideoInfo; sim: NonNullable<ReturnType<typeof parseSim>>; sceneIndex: number; lineIndex: number; seconds: number }) {
  const target = useMemo(() => simValuesAt(info.script, sim, sceneIndex, lineIndex), [info.script, sim, sceneIndex, lineIndex])
  // その場面に入ったときは、前のせりふまでの値から始める
  const [values, setValues] = useState(() => (lineIndex > 0 ? simValuesAt(info.script, sim, sceneIndex, lineIndex - 1) : simValuesAt(info.script, sim, sceneIndex, -1)))
  const shown = useRef(values)
  shown.current = values
  useEffect(() => {
    const from = shown.current
    if (Object.keys(target).every((name) => from[name] === target[name])) return
    const length = Math.max(900, Math.min(2600, seconds * 550))
    const begin = performance.now() + 350
    let frame = 0
    const step = (now: number) => {
      const t = Math.max(0, Math.min(1, (now - begin) / length))
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
      setValues(Object.fromEntries(Object.keys(target).map((name) => [name, (from[name] ?? target[name]) + (target[name] - (from[name] ?? target[name])) * eased])))
      if (t < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [target, seconds])
  const View = SIM_VIEWS[sim.kind]
  return (
    <div className="vs-sim" data-kind={sim.kind}>
      <div className="sim-stage">
        <View spec={sim} values={values} choices={sim.choices} render={render} />
      </div>
      <p className="vs-sim-values">
        {Object.entries(SIMS[sim.kind]?.params ?? {})
          .filter(([name]) => name in values)
          .map(([name, param]) => (
            <span key={name}>
              {param.label} <b>{Number(values[name].toFixed(param.step < 1 ? 1 : 0))}</b> {param.unit}
            </span>
          ))}
      </p>
    </div>
  )
}
