/**
 * 表示する言語の切りかえ。
 *
 * コードの中の文言は日本語のまま t('…') で囲み、ほかの言語のときは、辞書（i18n/<言語>.ts。日本語の文 → 訳）を引いて置きかえる。
 * 辞書に無い文は、日本語のまま表示する。文の中の値は {0}・{1}… で表し、訳では順番を入れかえられる。
 *
 * 言語は、アプリを開いたときに決まる（モジュールを読みこむ時点で文言を決めている所があるので、切りかえたらアプリを開き直す）。
 */
import { en } from './i18n/en.ts'

export type Lang = 'ja' | 'en'

/** 選べる言語（label は、その言語での呼び名） */
export const LANGUAGES: { id: Lang; label: string }[] = [
  { id: 'ja', label: '日本語' },
  { id: 'en', label: 'English' },
]

const TABLES: Partial<Record<Lang, Record<string, string>>> = { en }

let current: Lang = 'ja'

export const isLang = (value: unknown): value is Lang => LANGUAGES.some((l) => l.id === value)

export function setLang(lang: Lang): void {
  current = lang
}

export const getLang = (): Lang => current

/** 辞書を引くだけ（値の差しこみはしない） */
export function translate(text: string): string {
  if (current === 'ja') return text
  const table = TABLES[current]
  return table && Object.prototype.hasOwnProperty.call(table, text) ? table[text] : text
}

/** 文言を、いまの言語にする。{0}・{1}… には values を順に入れる */
export function t(text: string, ...values: unknown[]): string {
  const found = translate(text)
  if (!values.length) return found
  return found.replace(/\{(\d+)\}/g, (whole, index) => (Number(index) < values.length ? String(values[Number(index)] ?? '') : whole))
}
