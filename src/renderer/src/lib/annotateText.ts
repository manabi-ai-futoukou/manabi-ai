import { createContext } from 'react'
import type { LessonAnnotation } from '@shared/annotate'

/**
 * 教科書の本文に、ふりがな（ルビ）と、用語の目印を付ける。
 *
 * Markdown を画面の部品に変える途中（HTML の木になったところ）で、文字の部分を調べて、
 * - 読みのある言葉を <ruby>言葉<rt>よみ</rt></ruby> に
 * - 用語を <span class="gterm" data-term="用語"> … </span> に
 * 置きかえる。数式・コード・リンクの中は、さわらない。
 * ふりがなと用語の目印は、段落（箇条書きの 1 項目・表の 1 ます）ごとに、はじめの 1 回だけ付ける（全部に付けると読みにくい）。
 */

export interface AnnotateOptions {
  /** ふりがなを出すか */
  furigana: boolean
  /** 言葉 → 読み */
  readings: Map<string, string>
  /** 本文に出てくる書き方（用語・別の書き方）→ 用語集での用語 */
  terms: Map<string, string>
}

/** 教科書の本文（その中の掛け合いなども）に付ける、ふりがなと用語。無ければ、付けない */
export const AnnotationContext = createContext<AnnotateOptions | null>(null)

/** 注釈から、本文に付けるものを作る */
export function annotateOptions(annotation: LessonAnnotation | null | undefined, furigana: boolean): AnnotateOptions | null {
  if (!annotation && !furigana) return null
  const readings = new Map<string, string>()
  const terms = new Map<string, string>()
  for (const [word, reading] of annotation?.readings ?? []) readings.set(word, reading)
  const names = new Set((annotation?.terms ?? []).map((term) => term.term))
  for (const term of annotation?.terms ?? []) {
    // 1 字の用語は、本文のあちこちに当たってしまうので、目印を付けない。別の書き方が、ほかの用語と同じなら、そちらを優先する
    for (const word of [term.term, ...term.aliases.filter((alias) => !names.has(alias))]) if ([...word].length >= 2 && !terms.has(word)) terms.set(word, term.term)
    if (KANJI.test(term.term)) readings.set(term.term, term.reading)
  }
  return { furigana, readings, terms }
}

interface HastText {
  type: 'text'
  value: string
}
interface HastElement {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children: HastNode[]
}
type HastNode = HastText | HastElement | { type: string; children?: HastNode[]; value?: string }

const KANJI = /[㐀-鿿々〆ヶ]/
const KANJI_RUN = /[㐀-鿿々〆ヶ]+/g
/** 本文に「庄内平野（しょうないへいや）」のように書かれている読み（小学校の授業に多い） */
const INLINE = '([\\u3400-\\u9fff々〆ヶ]{1,12})（([ぁ-ゖー]{1,24})）'
const SKIP_TAGS = new Set(['code', 'pre', 'a', 'ruby', 'rt', 'rp', 'script', 'style', 'svg', 'math', 'button'])
const BLOCK_TAGS = new Set(['p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'dt', 'dd'])
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const toHiragana = (text: string) => text.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
const text = (value: string): HastText => ({ type: 'text', value })
const ruby = (base: string, reading: string): HastElement => ({ type: 'element', tagName: 'ruby', properties: {}, children: [text(base), { type: 'element', tagName: 'rt', properties: {}, children: [text(reading)] }] })

/**
 * 言葉と、その全体の読みから、漢字の部分だけにふりがなを付けた並びを作る。
 * 例: 「悼む」+「いたむ」→ 悼（いた）む ／「西ゴート王国」+「にしごーとおうこく」→ 西（にし）ゴート王国（おうこく）
 * うまく分けられないときは、言葉全体に読みを付ける。
 */
export function rubyParts(word: string, reading: string): HastNode[] {
  if (!KANJI.test(word)) return [text(word)]
  const parts: { kanji: boolean; value: string }[] = []
  let last = 0
  for (const found of word.matchAll(KANJI_RUN)) {
    if (found.index > last) parts.push({ kanji: false, value: word.slice(last, found.index) })
    parts.push({ kanji: true, value: found[0] })
    last = found.index + found[0].length
  }
  if (last < word.length) parts.push({ kanji: false, value: word.slice(last) })
  if (parts.length === 1) return [ruby(word, reading)]
  // かな・カタカナの部分は、読みの中の同じ文字と合わせる（空白は、読みには無い）
  const pattern = parts.map((part) => (part.kanji ? '(.+?)' : escape(toHiragana(part.value).replace(/[\s　]/g, '')))).join('')
  const found = new RegExp(`^${pattern}$`).exec(reading)
  if (!found) return [ruby(word, reading)]
  let at = 1
  return parts.map((part) => (part.kanji ? ruby(part.value, found[at++]) : text(part.value)))
}

/** rehype の部品。options を変えるたびに、新しく作る */
export function rehypeAnnotate(options: AnnotateOptions) {
  const words = [...new Set([...(options.furigana ? options.readings.keys() : []), ...options.terms.keys()])].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`${INLINE}${words.length ? `|(${words.map(escape).join('|')})` : ''}`, 'g')

  function annotate(value: string, seen: Set<string>, inHeading: boolean): HastNode[] | null {
    const out: HastNode[] = []
    let last = 0
    let changed = false
    pattern.lastIndex = 0
    for (let found = pattern.exec(value); found; found = pattern.exec(value)) {
      const [whole, base, inlineReading, word] = found
      let made: HastNode[] | null = null
      if (base) {
        // 本文に（ ）で書かれた読みは、ふりがなを出すときだけ、ルビにして（ ）を消す
        if (options.furigana) made = [ruby(base, inlineReading)]
      } else if (word && !seen.has(word)) {
        const reading = options.furigana ? options.readings.get(word) : undefined
        const term = inHeading ? undefined : options.terms.get(word)
        if (reading || term) {
          seen.add(word)
          const inner = reading ? rubyParts(word, reading) : [text(word)]
          made = term ? [{ type: 'element', tagName: 'span', properties: { className: ['gterm'], dataTerm: term }, children: inner }] : inner
        }
      }
      if (!made) continue
      if (found.index > last) out.push(text(value.slice(last, found.index)))
      out.push(...made)
      last = found.index + whole.length
      changed = true
    }
    if (!changed) return null
    if (last < value.length) out.push(text(value.slice(last)))
    return out
  }

  function walk(node: HastNode, seen: Set<string>, inHeading: boolean): void {
    const children = (node as HastElement).children
    if (!children) return
    const next: HastNode[] = []
    for (const child of children) {
      if (child.type === 'text') {
        next.push(...(annotate((child as HastText).value, seen, inHeading) ?? [child]))
        continue
      }
      if (child.type === 'element') {
        const el = child as HastElement
        const classes = ([] as unknown[]).concat(el.properties?.['className'] ?? []).join(' ')
        if (!SKIP_TAGS.has(el.tagName) && !/\b(math|katex)\b/.test(classes)) walk(el, BLOCK_TAGS.has(el.tagName) ? new Set() : seen, inHeading || HEADINGS.has(el.tagName))
      }
      next.push(child)
    }
    ;(node as HastElement).children = next
  }

  return () => (tree: HastNode) => walk(tree, new Set(), false)
}
