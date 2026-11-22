/**
 * ペン入力の診断用の記録。描画のたびに React の状態を更新すると遅くなるので、
 * ここに書きこんでおき、診断パネルが一定間隔で読みに来る。
 */
export interface PenStats {
  pointerType: string
  pressure: number
  minPressure: number
  maxPressure: number
  tiltX: number
  tiltY: number
  /** 線を書いている間の、1 秒あたりの座標の数（多いほど線がなめらかになる） */
  rate: number
  penSeen: boolean
  eraserSeen: boolean
  strokes: number
}

const fresh = (): PenStats => ({
  pointerType: '',
  pressure: 0,
  minPressure: 1,
  maxPressure: 0,
  tiltX: 0,
  tiltY: 0,
  rate: 0,
  penSeen: false,
  eraserSeen: false,
  strokes: 0,
})

export let penStats: PenStats = fresh()
let strokeStart = 0
let strokeSamples = 0

export function resetPenStats(): void {
  penStats = fresh()
}

/** 線を書き始めたときに呼ぶ */
export function recordStrokeStart(): void {
  strokeStart = performance.now()
  strokeSamples = 0
}

/** 線を書いている最中の入力を 1 件記録する */
export function recordSample(event: PointerEvent, drawing: boolean): void {
  penStats.pointerType = event.pointerType
  penStats.tiltX = event.tiltX
  penStats.tiltY = event.tiltY
  if (event.pointerType === 'pen') penStats.penSeen = true
  if (!drawing) return
  penStats.pressure = event.pressure
  if (event.pointerType === 'pen' && event.pressure > 0) {
    penStats.minPressure = Math.min(penStats.minPressure, event.pressure)
    penStats.maxPressure = Math.max(penStats.maxPressure, event.pressure)
  }
  // 1 本の線を書いている時間で割る。直近 1 秒間の件数を数える方式だと、
  // 1 秒より短い線では実際より少ない値になってしまう。
  strokeSamples += 1
  const elapsed = performance.now() - strokeStart
  if (elapsed >= 150) penStats.rate = Math.round(strokeSamples / (elapsed / 1000))
}

export function recordStrokeEnd(eraser: boolean): void {
  penStats.strokes += 1
  penStats.pressure = 0
  if (eraser) penStats.eraserSeen = true
}
