/**
 * 新しい ID（UUID の形）を作る。
 *
 * crypto.randomUUID は、https か localhost のページでしか使えない。
 * 同じネットワークの iPhone・iPad から http://192.168.x.x で Web 版を開くと「関数ではない」というエラーになり、
 * 書いた線が保存されずに消える・漢字ノートが開かない、という不具合になった（2026-11-20）。
 * 画面側で ID を作るときは、かならずこの関数を使う。
 */
export function newId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const b = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b)
  else for (let i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
