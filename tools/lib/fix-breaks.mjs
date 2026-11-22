// 直しで消えた改行（段落の切れ目）を、直す前の文をたよりに戻す。AI は使わない。
//
// 直す役の AI には、文を 1 行にして見せている（改行は空白 1 つになる）。返ってくる文も 1 行なので、
// そのまま入れると、論述の解答例の段落がつながってしまう。直す前の文の「改行の前後の文字」が、
// 直した文の中で空白 1 つをはさんで並んでいるところを探して、もとの改行に戻す。

const BREAK = /\s*\n\s*/g
const SENTENCE_END = '。．！？!?）」』\\]$'
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const countOf = (hay, needle) => hay.split(needle).length - 1

/**
 * before の改行を、after の同じ場所に戻す。
 * after にもう改行があるとき（AI が自分で段落を分けたとき）は、さわらない。
 * 返すもの: { text, restored（戻した数）, missed（場所が見つからなかった数） }
 */
export function restoreBreaks(before, after) {
  const source = String(before ?? '').trim()
  let text = String(after ?? '')
  const seps = source.match(BREAK) ?? []
  if (!seps.length || text.includes('\n')) return { text, restored: 0, missed: 0 }
  const parts = source.split(BREAK).map((p) => [...p])
  let restored = 0
  let missed = 0
  /** at の位置にある空白 1 つを（gap が 0 なら、何も消さずに）改行に置きかえる */
  const put = (at, sep, gap = 1) => {
    text = text.slice(0, at) + sep + text.slice(at + gap)
    restored += 1
    return true
  }
  for (let i = 1; i < parts.length; i += 1) {
    const prev = parts[i - 1]
    const next = parts[i]
    const sep = seps[i - 1]
    let done = false
    // 1. 改行の前と後の文字が、空白 1 つをはさんで並んでいるところ（1 か所だけのとき）
    for (let k = 12; k >= 3 && !done; k -= 1) {
      const tail = prev.slice(-k).join('')
      const head = next.slice(0, k).join('')
      if (!tail || !head) break
      if (countOf(text, `${tail} ${head}`) === 1) done = put(text.indexOf(`${tail} ${head}`) + tail.length, sep)
      else if (countOf(text, `${tail}${head}`) === 1 && countOf(source, `${tail}${head}`) === 0) done = put(text.indexOf(`${tail}${head}`) + tail.length, sep, 0)
    }
    // 2. 改行の前が書きかえられたとき: 文の終わり + 空白 + 改行の後の文字
    for (let k = 10; k >= 4 && !done; k -= 1) {
      const head = next.slice(0, k).join('')
      if ([...head].length < 4) break
      const hits = [...text.matchAll(new RegExp(`[${SENTENCE_END}] ${escape(head)}`, 'g'))]
      if (hits.length === 1) done = put(hits[0].index + [...hits[0][0]][0].length, sep)
    }
    // 3. 改行の後が書きかえられたとき: 改行の前の文字（文の終わりで終わるもの）+ 空白
    for (let k = 10; k >= 4 && !done; k -= 1) {
      const tail = prev.slice(-k).join('')
      if ([...tail].length < 4 || !new RegExp(`[${SENTENCE_END}]$`).test(tail)) break
      if (countOf(text, `${tail} `) === 1) done = put(text.indexOf(`${tail} `) + tail.length, sep)
    }
    // 4. 空白も消えたとき: 文の終わりのすぐあとに、改行の後の文字が続くところ（もとの文には無い並び）
    for (let k = 10; k >= 4 && !done; k -= 1) {
      const head = next.slice(0, k).join('')
      if ([...head].length < 4) break
      const joined = new RegExp(`[${SENTENCE_END}]${escape(head)}`, 'g')
      const hits = [...text.matchAll(joined)]
      if (hits.length === 1 && !source.match(joined)) done = put(hits[0].index + [...hits[0][0]][0].length, sep, 0)
    }
    if (!done) missed += 1
  }
  return { text, restored, missed }
}

/**
 * 分かち書きでない文で、まだ「。+ 空白」が残っているところを、段落の切れ目に戻す。
 * （直す前の文に「。+ 空白」が 1 つも無いときだけ。日本語のふつうの文には無い並びなので、改行のなごりと見てよい）
 */
export function restoreLooseBreaks(before, text) {
  const source = String(before ?? '')
  const seps = source.trim().match(BREAK) ?? []
  if (!seps.length || /。[ 　]/.test(source)) return { text, restored: 0 }
  // もとの文でいちばん多い切れ目の形（空行あり・なし）に合わせる
  const blank = seps.filter((s) => (s.match(/\n/g) ?? []).length > 1).length * 2 >= seps.length
  let restored = 0
  const next = text.replace(/。 (?=\S)/g, () => {
    restored += 1
    return `。${blank ? '\n\n' : '\n'}`
  })
  return { text: next, restored }
}
