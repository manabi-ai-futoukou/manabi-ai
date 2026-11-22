import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { MediaInfo } from '@shared/types'
import { getLang } from '@shared/i18n'
import { dataDir } from './paths'

/**
 * 授業の挿絵と、歴史上の人物の絵。
 * 画像は利用者のデータ置き場の media/ に置き、何の絵か・出どころは media/media.json に書く。
 *   pictures … 挿絵（本文の ```picture の id で引く）
 *   people   … 人物の絵（掛け合いに出てくる名前で引く）
 * kind は、generated（AI が描いたイメージ）か public（公開されている肖像画や写真。credit に出典を書く）。
 */

interface Entry {
  file: string
  kind: 'generated' | 'public'
  credit?: string
  alt?: string
  source?: string
}

interface Manifest {
  pictures: Record<string, Entry>
  people: Record<string, Entry>
}

const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
const FILE = /^[A-Za-z0-9][\w.-]{0,80}\.(png|jpg|jpeg|webp)$/
const MAX_BYTES = 4 * 1024 * 1024

let cached: { stamp: number; manifest: Manifest } | null = null

/** 一覧は、アプリの外（画像を入れる道具）が書きかえるので、変わっていたら読み直す */
function manifest(): Manifest {
  const file = join(dataDir('media'), 'media.json')
  if (!existsSync(file)) return { pictures: {}, people: {} }
  const stamp = statSync(file).mtimeMs
  if (!cached || cached.stamp !== stamp) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Manifest>
      cached = { stamp, manifest: { pictures: raw.pictures ?? {}, people: raw.people ?? {} } }
    } catch {
      cached = { stamp, manifest: { pictures: {}, people: {} } }
    }
  }
  return cached.manifest
}

/** 画像の説明の訳（日本語以外で表示しているとき。<データ置き場>/i18n/<言語>/media.json に、絵の ID → 説明） */
let alts: { stamp: number; lang: string; pictures: Record<string, string> } | null = null
function translatedAlt(id: string): string | null {
  const lang = getLang()
  if (lang === 'ja') return null
  const file = join(dataDir('i18n', lang), 'media.json')
  const stamp = existsSync(file) ? statSync(file).mtimeMs : 0
  if (!alts || alts.stamp !== stamp || alts.lang !== lang) {
    let pictures: Record<string, string> = {}
    try {
      if (stamp) pictures = (JSON.parse(readFileSync(file, 'utf8')) as { pictures?: Record<string, string> }).pictures ?? {}
    } catch {
      pictures = {}
    }
    alts = { stamp, lang, pictures }
  }
  return Object.prototype.hasOwnProperty.call(alts.pictures, id) ? alts.pictures[id] : null
}

/** 出典の書き方を、表示の言語に合わせる（日本語の記号と決まり文句を置きかえるだけ） */
function localCredit(credit: string): string {
  if (getLang() === 'ja') return credit
  return credit.replace('（パブリックドメイン）', ' (public domain)').replace(/（([^）]*)）/g, ' ($1)').replace(/／/g, ' / ')
}

function load(entry: Entry | undefined, id = ''): MediaInfo | null {
  if (!entry || !FILE.test(String(entry.file))) return null
  const file = join(dataDir('media'), entry.file)
  if (!existsSync(file) || statSync(file).size > MAX_BYTES) return null
  const type = TYPES[entry.file.split('.').pop()!.toLowerCase()]
  return {
    url: `data:${type};base64,${readFileSync(file).toString('base64')}`,
    kind: entry.kind === 'public' ? 'public' : 'generated',
    credit: localCredit(String(entry.credit ?? '')).slice(0, 200),
    alt: String((id && translatedAlt(id)) ?? entry.alt ?? '').slice(0, 300),
    // 外のページは、https のものだけを通す
    source: String(entry.source ?? '').startsWith('https://') && !/[\s"<>]/.test(String(entry.source)) ? String(entry.source).slice(0, 500) : '',
  }
}

// 名前がオブジェクトのもともとの性質（constructor など）に当たらないよう、自分の持ちものだけを見る
const own = (table: Record<string, Entry>, key: string) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined)

export const getPicture = (id: string): MediaInfo | null => load(own(manifest().pictures, String(id)), String(id))
export const getPerson = (name: string): MediaInfo | null => load(own(manifest().people, String(name)))
