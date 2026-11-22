/**
 * 授業の本文に、あとから足す部品（動く図解 ```sim、挿絵 ```picture）を差しこむ・取りのぞくための決まり。
 * 本文そのものには手を加えず、決まった位置にブロックを足すだけなので、取りのぞけば元の本文にもどる。
 * （掛け合い ```talk の決まりは talk.ts）
 */

export type BlockKind = 'sim' | 'picture'

/** 挿絵。id は、アプリのデータ置き場にある画像の名前（media.json の pictures の見出し） */
export interface PictureSpec {
  id: string
  caption: string
}

export function parsePicture(source: string): PictureSpec | null {
  try {
    const raw = JSON.parse(source) as Record<string, unknown>
    const id = String(raw['id'] ?? '')
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,79}$/.test(id)) return null
    return { id, caption: String(raw['caption'] ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) }
  } catch {
    return null
  }
}

export const formatPicture = (spec: PictureSpec) => '```picture\n' + JSON.stringify(spec) + '\n```'

/** 本文に、その種類のブロックがすでにあるか */
export const hasBlock = (body: string, kind: BlockKind) => new RegExp('^```' + kind + '\\s*$', 'm').test(body)

/** 本文から、その種類のブロックを取りのぞく（差しこむ前の本文にもどる） */
export function stripBlocks(body: string, kind: BlockKind): string {
  return body.replace(/\r\n/g, '\n').replace(new RegExp('^```' + kind + '\\n[\\s\\S]*?\\n```\\n\\n?', 'gm'), '')
}

/** ブロックを置かない節（ねらい・問題・答え・ノート） */
const CLOSED = /ねらい|確かめ問題|答え|ノートに書いてみましょう|考えるヒント/
/** 置き場所が決まらないときに、その前に置く節 */
const FALLBACK = /例題|例文|やってみましょう|資料から考える|確かめ問題/

/**
 * 指定された見出しの節の終わり（次の「## 」の見出しの前）に、ブロックを差しこむ。
 * 見出しが見つからないときは、例題（無ければ確かめ問題）の前に置く。置ける場所が無ければ null。
 * 節の終わりに掛け合いがあるときは、その前に置く（掛け合いは、次の節の直前にあるほうが自然なため）。
 */
export function insertAfterSection(body: string, heading: string, block: string): string | null {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const headings: number[] = []
  let fenced = false
  lines.forEach((line, i) => {
    if (/^```/.test(line)) fenced = !fenced
    else if (!fenced && /^## /.test(line)) headings.push(i)
  })
  const wanted = heading.replace(/^#+\s*/, '').trim()
  const title = (i: number) => lines[i].replace(/^## /, '').trim()
  let section = wanted ? headings.findIndex((i) => title(i) === wanted) : -1
  if (section < 0 && wanted) section = headings.findIndex((i) => title(i).includes(wanted) || wanted.includes(title(i)))
  let at: number
  if (section >= 0 && !CLOSED.test(title(headings[section]))) at = headings[section + 1] ?? lines.length
  else {
    const fallback = headings.find((i) => FALLBACK.test(title(i)))
    if (fallback === undefined) return null
    at = fallback
  }
  // 直前が掛け合いなら、その前へ
  let k = at - 1
  while (k >= 0 && !lines[k].trim()) k--
  if (k >= 0 && lines[k] === '```') {
    let open = k - 1
    while (open >= 0 && !/^```/.test(lines[open])) open--
    if (open >= 0 && lines[open] === '```talk') at = open
  }
  const before = at > 0 && lines[at - 1].trim() ? [''] : []
  lines.splice(at, 0, ...before, block, '')
  return lines.join('\n')
}
