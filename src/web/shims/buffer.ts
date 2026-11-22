/**
 * Node の Buffer の代わり（Web 版）。本体側のコードが使っている範囲だけを用意する:
 * Buffer.from(文字列, 'base64' | 'utf8' | 'utf16le')・Buffer.from(バイト列)・Buffer.alloc・Buffer.concat・toString('utf8' | 'base64' | 'hex')。
 */
type Encoding = 'utf8' | 'utf-8' | 'base64' | 'hex' | 'utf16le' | 'latin1' | 'binary'

function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/[^A-Za-z0-9+/=]/g, ''))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  // 大きな画像でも引数の数の上限に当たらないよう、小分けにして文字にする
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export class WebBuffer extends Uint8Array {
  static override from(data: unknown, encoding?: unknown): WebBuffer {
    if (typeof data === 'string') {
      const enc = (typeof encoding === 'string' ? encoding : 'utf8') as Encoding
      if (enc === 'base64') return WebBuffer.wrap(fromBase64(data))
      if (enc === 'hex') return WebBuffer.wrap(Uint8Array.from(data.match(/.{2}/g) ?? [], (pair) => parseInt(pair, 16)))
      if (enc === 'utf16le') {
        const out = new Uint8Array(data.length * 2)
        for (let i = 0; i < data.length; i++) {
          const code = data.charCodeAt(i)
          out[i * 2] = code & 0xff
          out[i * 2 + 1] = code >> 8
        }
        return WebBuffer.wrap(out)
      }
      if (enc === 'latin1' || enc === 'binary') return WebBuffer.wrap(Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff))
      return WebBuffer.wrap(new TextEncoder().encode(data))
    }
    if (data instanceof ArrayBuffer) return WebBuffer.wrap(new Uint8Array(data))
    if (ArrayBuffer.isView(data)) return WebBuffer.wrap(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    return WebBuffer.wrap(Uint8Array.from(data as ArrayLike<number>))
  }

  /** 中身を写さずに、Buffer として扱えるようにする */
  static wrap(bytes: Uint8Array): WebBuffer {
    return new WebBuffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)
  }

  static alloc(size: number): WebBuffer {
    return new WebBuffer(size)
  }

  static concat(list: Uint8Array[]): WebBuffer {
    const out = new WebBuffer(list.reduce((sum, part) => sum + part.length, 0))
    let at = 0
    for (const part of list) {
      out.set(part, at)
      at += part.length
    }
    return out
  }

  static isBuffer(value: unknown): value is WebBuffer {
    return value instanceof WebBuffer
  }

  static byteLength(text: string): number {
    return new TextEncoder().encode(text).length
  }

  override toString(encoding?: string): string {
    if (encoding === 'base64') return toBase64(this)
    if (encoding === 'hex') return Array.from(this, (b) => b.toString(16).padStart(2, '0')).join('')
    if (encoding === 'latin1' || encoding === 'binary') return Array.from(this, (b) => String.fromCharCode(b)).join('')
    return new TextDecoder(encoding === 'utf16le' ? 'utf-16le' : 'utf-8').decode(this)
  }
}

/** 本体側のコードは Buffer と process をそのまま使うので、最初に置いておく */
export function installGlobals(env: Record<string, string> = {}): void {
  const scope = globalThis as Record<string, unknown>
  scope['Buffer'] ??= WebBuffer
  scope['process'] ??= { env, platform: 'web', versions: {}, cwd: () => '/' }
  // Node のタイマーは「これを待たずに終わってよい」と言える（unref）。ブラウザのタイマーは数なので、何もしない unref を足しておく
  const numbers = Number.prototype as unknown as { unref?: () => unknown; ref?: () => unknown }
  numbers.unref ??= function (this: number) {
    return this
  }
  numbers.ref ??= function (this: number) {
    return this
  }
}
