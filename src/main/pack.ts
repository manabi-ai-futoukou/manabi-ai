/**
 * インストーラーに入っている教材（content-pack）を、利用者のデータの置き場へ写す。
 * はじめて開いたときと、アプリを新しくして教材の版が変わったときだけ動く。開発中（パッケージしていないとき）は、何もしない。
 *
 * - パックにあるファイルは、置き場の同じ名前のファイルを置きかえる（教材の新しい版にする）。
 *   ただし、パックを作った時刻（pack.json の builtAt）よりあとに書きかえられたファイルは、利用者のもののほうが新しいので、さわらない。
 *   インストーラーから出したファイルの時刻は、どれも「インストーラーを作った時刻」になるので、ファイルどうしの時刻では、くらべられない
 * - 授業の記録（lessons-index.json）と、絵の表（media.json）は、利用者の側の項目を残したまま、パックの項目を足す
 * - ノート・会話・成績・設定には、さわらない（パックに入っていない）
 *
 * パックは、道具（tools/prepare-release.mjs）が、公開する科目の教材だけを集めて作る。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { copyFile, readdir, stat, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BrowserWindow, app } from 'electron'
import { t } from '@shared/i18n'
import { dataDir } from './paths'

/** 利用者の側の中身と、まとめて 1 つにするファイル（上書きしない） */
const MERGED = new Set(['lessons-index.json', 'media/media.json', 'i18n/en/lessons-index.json', 'i18n/en/media.json'])
/** Web 版だけが使うもの（Windows 版には要らない） */
const skip = (rel: string) => rel === 'pack.json' || rel.endsWith('_list.json') || rel.endsWith('_summary.json') || rel.startsWith('search/')

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

async function walk(dir: string, base = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await walk(join(dir, entry.name), rel)))
    else if (!skip(rel)) out.push(rel)
  }
  return out
}

type Json = Record<string, unknown>
const isMap = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)
/** 利用者の側の項目を残したまま、パックの項目を足す（同じ項目は、パックのものにする。1 段だけ、中まで見る） */
function mergeJson(mine: Json | null, pack: Json): Json {
  const out: Json = { ...(mine ?? {}) }
  for (const [key, value] of Object.entries(pack)) out[key] = isMap(value) && isMap(out[key]) ? { ...(out[key] as Json), ...value } : value
  return out
}

/**
 * 教材を写す。写している間は、小さなウィンドウで進み具合を見せる。
 * 返すのは、そのウィンドウを閉じる関数（はじめの画面を開いたあとで呼ぶ。先に閉じると、ウィンドウが 1 つも無くなって、アプリが終わってしまう）。
 */
export async function importPack(): Promise<() => void> {
  const nothing = () => undefined
  const pack = join(process.resourcesPath, 'content-pack')
  if (!app.isPackaged) return nothing
  const info = readJson<{ version?: string; builtAt?: number }>(join(pack, 'pack.json'))
  if (!info?.version) return nothing
  /** パックを作った時刻。これよりあとに書きかえられたファイルは、置きかえない */
  const builtAt = Number(info.builtAt) || Date.parse(`${info.version}Z`) || Date.now()
  const marker = join(dataDir(), 'pack.json')
  if (readJson<{ version?: string }>(marker)?.version === info.version) return nothing

  const splash = new BrowserWindow({ width: 480, height: 190, resizable: false, frame: false, backgroundColor: '#f7f3ea', webPreferences: { sandbox: true, contextIsolation: true } })
  const page = `<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-content:center;height:100vh;font-family:'BIZ UDPGothic','Yu Gothic UI',Meiryo,sans-serif;color:#2c2a35;background:#f7f3ea;text-align:center;line-height:1.9"><strong style="font-size:1.15rem">${t('学びアイ')}</strong><span>${t('教材を準備しています。はじめて開くときは、1〜2 分かかります。')}</span><span id="p" style="color:#2a7b8a"></span>`
  await splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
  const show = (text: string) => void splash.webContents.executeJavaScript(`document.getElementById('p').textContent = ${JSON.stringify(text)}`).catch(() => undefined)

  try {
    const files = await walk(pack)
    const root = dataDir()
    let done = 0
    let next = 0
    const made = new Set<string>()
    const one = async (rel: string): Promise<void> => {
      const from = join(pack, rel)
      const to = join(root, rel)
      const dir = dirname(to)
      if (!made.has(dir)) {
        mkdirSync(dir, { recursive: true })
        made.add(dir)
      }
      if (MERGED.has(rel)) {
        const value = readJson<Json>(from)
        if (value) writeFileSync(to, JSON.stringify(mergeJson(readJson<Json>(to), value)), 'utf8')
        return
      }
      const source = await stat(from)
      const target = await stat(to).catch(() => null)
      // パックを作ったあとに書きかえられたもの（利用者のほうが新しい）と、同じものが、もうあるときは写さない
      if (target && (target.mtimeMs > builtAt || (target.size === source.size && Math.abs(target.mtimeMs - source.mtimeMs) <= 2000))) return
      await copyFile(from, to)
      // 時刻は、パックを作った時刻より前にしておく（次の版が、また置きかえられるように）
      const stamp = new Date(Math.min(source.mtimeMs, builtAt))
      await utimes(to, stamp, stamp)
    }
    const worker = async (): Promise<void> => {
      while (next < files.length) {
        const rel = files[next++]
        await one(rel).catch(() => undefined)
        done += 1
        if (done % 500 === 0) show(`${done.toLocaleString()} / ${files.length.toLocaleString()}`)
      }
    }
    await Promise.all(Array.from({ length: 16 }, worker))
    writeFileSync(marker, JSON.stringify({ version: info.version, at: Date.now() }), 'utf8')
  } catch {
    // 写せなくても、アプリは開く（教材が無い授業は、AI が作る形で動く）。次に開いたときに、もう一度ためす
  }
  return () => {
    if (!splash.isDestroyed()) splash.destroy()
  }
}
