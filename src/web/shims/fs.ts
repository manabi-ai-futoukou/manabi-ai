/**
 * Node の fs の代わり（Web 版）。本体側のコード（src/main）を、書きかえずにブラウザのワーカーで動かすためのもの。
 *
 * ファイルは 2 種類ある。
 *   利用者のデータ（設定・ノート・会話・成績など）… メモリに持ち、変わるたびに IndexedDB へ書く（この端末の中だけに残る）
 *   教材（授業・単元表・訳・画像・同梱の資料）… サーバーから読むだけ。開いたものだけを取り寄せる
 * 本体側は「待たずに読む」作りなので、教材は、ワーカーの中で使える「待つ通信」（同期の XMLHttpRequest）で取り寄せる。
 * 教材と同じ場所に利用者が書いたもの（アプリの中で作った授業など）があれば、そちらを使う。
 */
import { WebBuffer } from './buffer'
import { dirname, normalize } from './path'

type Data = string | Uint8Array
interface LocalFile {
  data: Data
  mtime: number
}
interface RemoteEntry {
  size: number
  mtime: number
  dir: boolean
}

const local = new Map<string, LocalFile>()
const localDirs = new Set<string>(['/'])

// ───────── 教材（サーバーから読むだけ） ─────────

let base = '/'
/** 利用者のデータ置き場のうち、サーバーにも教材があるフォルダ */
const REMOTE_DATA = ['lessons', 'curricula', 'i18n', 'media', 'annot', 'essay']
const REMOTE_FILES = ['/user/data/lessons-index.json']

function remoteUrl(path: string): string | null {
  const encode = (rest: string) => rest.split('/').map(encodeURIComponent).join('/')
  if (path === '/app/resources' || path.startsWith('/app/resources/')) return `${base}res/${encode(path.slice('/app/resources/'.length))}`
  if (REMOTE_FILES.includes(path)) return `${base}data/${encode(path.slice('/user/data/'.length))}`
  if (path.startsWith('/user/data/')) {
    const rest = path.slice('/user/data/'.length)
    if (REMOTE_DATA.includes(rest.split('/')[0])) return `${base}data/${encode(rest)}`
  }
  return null
}

function request(url: string, binary: boolean): XMLHttpRequest {
  const xhr = new XMLHttpRequest()
  xhr.open('GET', url, false)
  if (binary) xhr.responseType = 'arraybuffer'
  try {
    xhr.send()
  } catch {
    // つながらないときは「無い」として扱う（呼び出した側が、無いときの動きをする）
  }
  return xhr
}

/**
 * フォルダの中身を、サーバーにたずねる。
 * - 学びアイのサーバー（web/server.mjs）は、「<フォルダ>/?list=1」に JSON で答える。
 * - ファイルを置くだけの場所（ChatGPT Sites の静的なサイトなど）では、その問いに答えられないので、
 *   前もって作ってあるファイル「<フォルダ>/_list.json」を読む（tools/export-site.mjs が作る）。
 *   1 回そうなったら、あとは、はじめから _list.json を読む。
 */
type RawListing = Record<string, [number, number] | 0>
let staticHost = false
function fetchListing(dirUrl: string): RawListing | null {
  const parse = (xhr: XMLHttpRequest): RawListing | null => {
    if (xhr.status !== 200) return null
    try {
      const raw = JSON.parse(xhr.responseText) as unknown
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as RawListing) : null
    } catch {
      return null
    }
  }
  if (!staticHost) {
    const answer = parse(request(`${dirUrl}/?list=1`, false))
    if (answer) return answer
  }
  const fixed = parse(request(`${dirUrl}/_list.json`, false))
  if (fixed) staticHost = true
  return fixed
}

/** フォルダの中身（名前 → 大きさ・更新時刻）。サーバーに 1 回だけ聞いて、覚えておく */
const listings = new Map<string, Map<string, RemoteEntry> | null>()
function listing(dir: string): Map<string, RemoteEntry> | null {
  if (listings.has(dir)) return listings.get(dir)!
  const url = remoteUrl(dir)
  let found: Map<string, RemoteEntry> | null = null
  // 上のフォルダの中身にこのフォルダが無いと分かっているときは、サーバーにたずねない
  // （科目ごとに「同梱の資料があるか」を確かめるので、たずねると、起動のたびに数百回の通信になる）
  const parent = dirname(dir)
  const known = !url || parent === dir || !remoteUrl(parent) || listing(parent)?.get(dir.split('/').pop()!)?.dir === true
  if (url && known) {
    const raw = fetchListing(url.replace(/\/$/, ''))
    if (raw) found = new Map(Object.entries(raw).map(([name, value]) => [name, value === 0 ? { size: 0, mtime: 0, dir: true } : { size: value[0], mtime: value[1], dir: false }]))
  }
  listings.set(dir, found)
  return found
}
const remoteEntry = (path: string): RemoteEntry | null => (remoteUrl(path) ? (listing(dirname(path))?.get(path.split('/').pop()!) ?? null) : null)

/** 取り寄せた教材の本文（文字のもの）を、少しのあいだ覚えておく */
const remoteText = new Map<string, string>()
function readRemote(path: string, binary: boolean): Data | null {
  if (!remoteEntry(path) || remoteEntry(path)!.dir) return null
  if (!binary && remoteText.has(path)) return remoteText.get(path)!
  const xhr = request(remoteUrl(path)!, binary)
  if (xhr.status !== 200) return null
  if (binary) return new Uint8Array(xhr.response as ArrayBuffer)
  if (remoteText.size > 400) remoteText.delete(remoteText.keys().next().value!)
  remoteText.set(path, xhr.responseText)
  return xhr.responseText
}

// ───────── 利用者のデータ（IndexedDB に残す） ─────────

let db: IDBDatabase | null = null
const pending = new Map<string, LocalFile | null>()
let timer: ReturnType<typeof setTimeout> | null = null
let writing: Promise<void> = Promise.resolve()
/** 一時ファイルは、端末に残さない */
const transient = (path: string) => path.endsWith('.tmp') || path.includes('/ai-temp/') || path.includes('/ai-workdir/')

function persist(path: string, value: LocalFile | null): void {
  if (transient(path)) return
  pending.set(path, value)
  timer ??= setTimeout(() => void flushFs(), 200)
}

/** 書きこみ待ちのものを、IndexedDB に書き終える */
export function flushFs(): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = null
  if (!db || !pending.size) return writing
  const batch = [...pending]
  pending.clear()
  const store = db
  writing = writing.then(
    () =>
      new Promise<void>((done) => {
        const tx = store.transaction('files', 'readwrite')
        for (const [path, value] of batch) {
          if (value) tx.objectStore('files').put(value, path)
          else tx.objectStore('files').delete(path)
        }
        tx.oncomplete = () => done()
        tx.onerror = () => done()
        tx.onabort = () => done()
      }),
  )
  return writing
}

/** はじめに 1 回: 教材の取り寄せ先を決め、この端末に残っている利用者のデータを読みこむ */
export async function initFs(options: { base: string }): Promise<void> {
  base = options.base.endsWith('/') ? options.base : `${options.base}/`
  db = await new Promise<IDBDatabase | null>((done) => {
    const open = indexedDB.open('manabi-fs', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('files')
    open.onsuccess = () => done(open.result)
    open.onerror = () => done(null)
  })
  if (!db) return
  await new Promise<void>((done) => {
    const cursor = db!.transaction('files').objectStore('files').openCursor()
    cursor.onsuccess = () => {
      const at = cursor.result
      if (!at) return done()
      local.set(String(at.key), at.value as LocalFile)
      addDirs(dirname(String(at.key)))
      at.continue()
    }
    cursor.onerror = () => done()
  })
}

/** この端末に残っている利用者のデータを、すべて消す（設定の「データを消す」用） */
export async function clearFs(): Promise<void> {
  await flushFs()
  local.clear()
  if (db) await new Promise<void>((done) => {
    const tx = db!.transaction('files', 'readwrite')
    tx.objectStore('files').clear()
    tx.oncomplete = () => done()
    tx.onerror = () => done()
  })
}

/** 利用者のデータの量（ファイルの数と、おおよその大きさ） */
export function localUsage(): { files: number; bytes: number } {
  let bytes = 0
  for (const { data } of local.values()) bytes += typeof data === 'string' ? data.length * 2 : data.length
  return { files: local.size, bytes }
}

// ───────── fs の関数 ─────────

function addDirs(dir: string): void {
  let at = normalize(dir)
  while (at && at !== '/' && !localDirs.has(at)) {
    localDirs.add(at)
    at = dirname(at)
  }
}

function missing(path: string, call: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, ${call} '${path}'`), { code: 'ENOENT' })
}

const toBytes = (data: Data): Uint8Array => (typeof data === 'string' ? new TextEncoder().encode(data) : data)
const toText = (data: Data): string => (typeof data === 'string' ? data : new TextDecoder().decode(data))
const wantsText = (options: unknown): boolean => typeof options === 'string' || (!!options && typeof options === 'object' && !!(options as { encoding?: string }).encoding)

export function existsSync(path: string): boolean {
  const p = normalize(path)
  return local.has(p) || localDirs.has(p) || !!remoteEntry(p) || (!!remoteUrl(p) && !!listing(p))
}

export function readFileSync(path: string, options?: unknown): any {
  const p = normalize(path)
  const text = wantsText(options)
  const data = local.get(p)?.data ?? readRemote(p, !text)
  if (data === null || data === undefined) throw missing(p, 'open')
  return text ? toText(data) : WebBuffer.wrap(toBytes(data))
}

export function writeFileSync(path: string, data: string | Uint8Array, _options?: unknown): void {
  const p = normalize(path)
  const value: LocalFile = { data: typeof data === 'string' ? data : new Uint8Array(data), mtime: Date.now() }
  local.set(p, value)
  addDirs(dirname(p))
  persist(p, value)
}

export function appendFileSync(path: string, data: string | Uint8Array): void {
  const p = normalize(path)
  const before = local.get(p)?.data
  if (before === undefined) return writeFileSync(p, data)
  if (typeof before === 'string' && typeof data === 'string') return writeFileSync(p, before + data)
  writeFileSync(p, WebBuffer.concat([toBytes(before), toBytes(data)]))
}

export function readdirSync(path: string): string[] {
  const p = normalize(path)
  const prefix = p === '/' ? '/' : `${p}/`
  const names = new Set<string>()
  for (const key of local.keys()) if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) names.add(key.slice(prefix.length))
  for (const dir of localDirs) if (dir.startsWith(prefix) && !dir.slice(prefix.length).includes('/')) names.add(dir.slice(prefix.length))
  for (const name of listing(p)?.keys() ?? []) names.add(name)
  if (!names.size && !localDirs.has(p) && !listing(p)) throw missing(p, 'scandir')
  return [...names].sort()
}

export function statSync(path: string) {
  const p = normalize(path)
  const file = local.get(p)
  const remote = file ? null : remoteEntry(p)
  const isDir = !file && (localDirs.has(p) || !!remote?.dir || (!remote && !!remoteUrl(p) && !!listing(p)))
  if (!file && !remote && !isDir) throw missing(p, 'stat')
  const size = file ? (typeof file.data === 'string' ? new TextEncoder().encode(file.data).length : file.data.length) : (remote?.size ?? 0)
  const mtimeMs = file?.mtime ?? remote?.mtime ?? 0
  return { size, mtimeMs, mtime: new Date(mtimeMs), isDirectory: () => isDir, isFile: () => !isDir }
}

export function mkdirSync(path: string, _options?: unknown): void {
  addDirs(path)
}

export function renameSync(from: string, to: string): void {
  const a = normalize(from)
  const b = normalize(to)
  const file = local.get(a)
  if (!file) throw missing(a, 'rename')
  local.delete(a)
  persist(a, null)
  local.set(b, file)
  addDirs(dirname(b))
  persist(b, file)
}

export function unlinkSync(path: string): void {
  const p = normalize(path)
  if (!local.delete(p)) throw missing(p, 'unlink')
  persist(p, null)
}

export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void {
  const p = normalize(path)
  let removed = local.delete(p)
  if (removed) persist(p, null)
  if (options?.recursive) {
    for (const key of [...local.keys()]) {
      if (!key.startsWith(`${p}/`)) continue
      local.delete(key)
      persist(key, null)
      removed = true
    }
    for (const dir of [...localDirs]) if (dir === p || dir.startsWith(`${p}/`)) localDirs.delete(dir)
  }
  if (!removed && !options?.force && !options?.recursive) throw missing(p, 'rm')
}

export function copyFileSync(from: string, to: string): void {
  writeFileSync(to, readFileSync(from) as Uint8Array)
}

export function createWriteStream(): never {
  throw new Error('Web 版では、ファイルへの流しこみは使えません')
}

/** fs/promises にあたるもの */
export const promises = {
  writeFile: async (path: string, data: string | Uint8Array, _options?: unknown) => writeFileSync(path, data),
  readFile: async (path: string, options?: unknown) => readFileSync(path, options),
  rename: async (from: string, to: string) => renameSync(from, to),
  unlink: async (path: string) => unlinkSync(path),
  copyFile: async (from: string, to: string) => copyFileSync(from, to),
  stat: async (path: string) => statSync(path),
  mkdir: async (path: string) => mkdirSync(path),
  rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => rmSync(path, options),
}

export default { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, mkdirSync, renameSync, unlinkSync, rmSync, copyFileSync, createWriteStream, promises }
