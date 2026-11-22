/** Node の path の代わり（Web 版）。区切りは、いつも「/」。 */
export const sep = '/'

export function normalize(path: string): string {
  const absolute = path.startsWith('/')
  const out: string[] = []
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return (absolute ? '/' : '') + out.join('/') || (absolute ? '/' : '.')
}

export const join = (...parts: string[]): string => normalize(parts.filter(Boolean).join('/'))

export function resolve(...parts: string[]): string {
  let path = ''
  for (const part of parts) path = part.startsWith('/') ? part : `${path}/${part}`
  return normalize(path.startsWith('/') ? path : `/${path}`)
}

export function dirname(path: string): string {
  const at = normalize(path).lastIndexOf('/')
  return at <= 0 ? '/' : normalize(path).slice(0, at)
}

export function basename(path: string, ext = ''): string {
  const name = normalize(path).split('/').pop() ?? ''
  return ext && name.endsWith(ext) ? name.slice(0, -ext.length) : name
}

export function extname(path: string): string {
  const name = basename(path)
  const at = name.lastIndexOf('.')
  return at <= 0 ? '' : name.slice(at)
}

export default { sep, normalize, join, resolve, dirname, basename, extname }
