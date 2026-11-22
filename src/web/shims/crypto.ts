/** Node の crypto の代わり（Web 版）。使うのは randomUUID と、指紋づくりの createHash('sha1') だけ。 */

export function randomUUID(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // https でも localhost でもないページ（同じネットワークのタブレットから http で開いたとき）には randomUUID が無い
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** SHA-1（待たずに計算できるものが要るので、自前で持つ。指紋づくりにだけ使い、安全のためのものではない） */
function sha1(bytes: Uint8Array): Uint8Array {
  const length = bytes.length
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6)
  padded.set(bytes)
  padded[length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 2 ** 32))
  view.setUint32(padded.length - 4, (length * 8) >>> 0)
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]
  const w = new Uint32Array(80)
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n))
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1)
    let [a, b, c, d, e] = h
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6]
      const next = (rotl(a, 5) + f + e + k + w[i]) | 0
      e = d
      d = c
      c = rotl(b, 30)
      b = a
      a = next
    }
    h[0] = (h[0] + a) | 0
    h[1] = (h[1] + b) | 0
    h[2] = (h[2] + c) | 0
    h[3] = (h[3] + d) | 0
    h[4] = (h[4] + e) | 0
  }
  const out = new Uint8Array(20)
  const outView = new DataView(out.buffer)
  h.forEach((value, i) => outView.setUint32(i * 4, value >>> 0))
  return out
}

export function createHash(algorithm: string) {
  if (algorithm !== 'sha1') throw new Error(`Web 版では ${algorithm} を計算できません`)
  const parts: Uint8Array[] = []
  const hash = {
    update(data: string | Uint8Array) {
      parts.push(typeof data === 'string' ? new TextEncoder().encode(data) : data)
      return hash
    },
    digest(encoding?: string): string {
      const all = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
      let at = 0
      for (const part of parts) {
        all.set(part, at)
        at += part.length
      }
      const bytes = sha1(all)
      if (encoding && encoding !== 'hex') throw new Error(`Web 版では ${encoding} の形で返せません`)
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    },
  }
  return hash
}

export default { randomUUID, createHash }
