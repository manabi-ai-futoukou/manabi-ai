/**
 * 検索（教科書・ノート・メモ・用語集）で使う、文字の照合。
 * アプリ（本体側）と、Web 版の付属のサーバーの両方から使うので、型を消すだけで動く書き方にしてある。
 */

/** 見つけた言葉の前後に入れる目印（画面で、その部分に色を付ける） */
export const HIT_OPEN = ''
export const HIT_CLOSE = ''

/**
 * 探す言葉から、照合の形を作る。
 * - 言葉の中の空白は無視し、本文の側の空白も無視する（低学年向けの「分かち書き」の本文にも当たるように）
 * - 英字は、大文字と小文字を区別しない
 */
export function searchPattern(query: string): RegExp | null {
  const chars = [...String(query ?? '').replace(/[\s　]/g, '')].slice(0, 60)
  if (!chars.length) return null
  return new RegExp(chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[ 　]*'), 'i')
}

/** 授業の本文（Markdown）から、図やグラフの指定と、書式の記号を外す */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```(figure|plot|numberline|picture|sim)\n[\s\S]*?```/g, '')
    .replace(/```[a-z]*\n?|```/g, '')
    .replace(/\*\*|__|^#{1,6} |^\s*[-*] |^\s*> ?|\$\$?/gm, '')
    .replace(/\|/g, ' ')
}

/**
 * 文章の中から言葉を探して、出てくる回数と、前後を切り出した文（最大 max 個）を返す。
 * 切り出した文では、見つけた言葉の前後に目印（HIT_OPEN・HIT_CLOSE）を入れる。
 */
export function findSnippets(text: string, pattern: RegExp, max: number): { count: number; snippets: string[] } {
  const plain = plainText(text)
  const global = new RegExp(pattern.source, 'gi')
  const snippets: string[] = []
  let count = 0
  let lastEnd = -200
  for (let found = global.exec(plain); found; found = global.exec(plain)) {
    count += 1
    if (!found[0]) {
      global.lastIndex += 1
      continue
    }
    // 近くにある一致は、1 つの文にまとめて見せる
    if (snippets.length < max && found.index - lastEnd > 60) {
      const from = Math.max(0, found.index - 26)
      const to = Math.min(plain.length, found.index + found[0].length + 44)
      const line = `${from > 0 ? '…' : ''}${plain.slice(from, found.index)}${HIT_OPEN}${found[0]}${HIT_CLOSE}${plain.slice(found.index + found[0].length, to)}${to < plain.length ? '…' : ''}`
      snippets.push(line.replace(/\s+/g, ' ').trim())
      lastEnd = found.index + found[0].length
    }
  }
  return { count, snippets }
}
