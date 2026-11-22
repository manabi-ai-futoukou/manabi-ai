import { t } from '@/lib/i18n'
/**
 * マイクで声を録り、音声認識に渡せる形（16kHz・モノラル・16 ビットの WAV）にする。
 */

export interface Recording {
  wav: ArrayBuffer
  seconds: number
  /** いちばん大きかった音の大きさ（0〜1）。小さすぎれば、声が入っていないとみなす */
  peak: number
}

const RATE = 16000

function encodeWav(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // モノラル
  view.setUint32(24, RATE, true)
  view.setUint32(28, RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buffer
}

export class Recorder {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private context: AudioContext | null = null
  private frame = 0

  /** @param onLevel 録音中の音の大きさ（0〜1）を、画面の表示用に知らせる */
  constructor(private readonly onLevel?: (level: number) => void) {}

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    this.chunks = []
    this.recorder = new MediaRecorder(this.stream)
    this.recorder.ondataavailable = (event) => event.data.size && this.chunks.push(event.data)
    this.recorder.start()

    if (this.onLevel) {
      this.context = new AudioContext()
      const analyser = this.context.createAnalyser()
      analyser.fftSize = 512
      this.context.createMediaStreamSource(this.stream).connect(analyser)
      const data = new Float32Array(analyser.fftSize)
      const tick = () => {
        analyser.getFloatTimeDomainData(data)
        let sum = 0
        for (const value of data) sum += value * value
        this.onLevel?.(Math.min(1, Math.sqrt(sum / data.length) * 6))
        this.frame = requestAnimationFrame(tick)
      }
      tick()
    }
  }

  private release(): void {
    cancelAnimationFrame(this.frame)
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.context?.close()
    this.stream = null
    this.context = null
    this.onLevel?.(0)
  }

  /** 録音をやめて、捨てる */
  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
    this.recorder = null
    this.release()
  }

  /** 録音を終えて、WAV にして返す */
  async stop(): Promise<Recording> {
    const recorder = this.recorder
    if (!recorder) throw new Error(t('録音していません。'))
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
      recorder.stop()
    })
    this.recorder = null
    this.release()

    const encoded = await new Blob(this.chunks, { type: recorder.mimeType }).arrayBuffer()
    if (!encoded.byteLength) return { wav: new ArrayBuffer(0), seconds: 0, peak: 0 }
    const decoder = new AudioContext()
    let decoded: AudioBuffer
    try {
      decoded = await decoder.decodeAudioData(encoded)
    } finally {
      void decoder.close()
    }
    // 16kHz・モノラルに変換する
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * RATE)), RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const samples = (await offline.startRendering()).getChannelData(0)
    let peak = 0
    for (const value of samples) peak = Math.max(peak, Math.abs(value))
    return { wav: encodeWav(samples), seconds: decoded.duration, peak }
  }
}
