import { getLang, type Lang } from '@shared/i18n'

/**
 * AI への指示文を、表示の言語に合わせるための道具。
 *
 * 日本語のときは日本語の指示文を、それ以外のときは英語の指示文を使う。
 * 英語の指示文の中では、学習者に向けて書く言語を langName() で指定するので、
 * 言語を足すときは、ここに呼び名を足すだけで、同じ指示文が使える（その言語専用の指示文を書かなくてよい）。
 */

const NAMES: Record<Lang, string> = { ja: 'Japanese', en: 'English' }

/** いまの言語が日本語か */
export const isJa = (): boolean => getLang() === 'ja'

/** 学習者に向けて書く言語の、英語での呼び名（英語の指示文の中で使う） */
export const langName = (): string => NAMES[getLang()]

/** 日本語のときは ja を、それ以外のときは other を返す */
export const pick = <T>(ja: T, other: T): T => (isJa() ? ja : other)

/** 英語の指示文に入れる、書く言語の決まり */
export const writeIn = (): string => `Write everything the student will read in ${langName()}.`
