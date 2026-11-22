import { Fragment, createElement, type ReactNode } from 'react'
import { isLang, setLang, t, translate } from '@shared/i18n'

// 言語は、ウィンドウを開いた時点の設定で決まる（ほかのモジュールが文言を決める前に、ここで設定する）
setLang(isLang(window.manabi.lang) ? window.manabi.lang : 'ja')
document.documentElement.lang = window.manabi.lang

export { t }
export { getLang } from '@shared/i18n'

/** 日付や時刻を書くときの、言語と地域の指定 */
export const LOCALE = window.manabi.lang === 'ja' || !isLang(window.manabi.lang) ? 'ja-JP' : window.manabi.lang

/**
 * 画面に出す文の中に、値や部品（太字、ボタンなど）がはさまるときに使う。
 * {0}・{1}… の位置に values を入れた並びを返す（訳では、順番を入れかえられる）。
 */
export function tx(text: string, ...values: ReactNode[]): ReactNode {
  const parts = translate(text).split(/(\{\d+\})/)
  return createElement(
    Fragment,
    null,
    ...parts.map((part) => {
      const found = /^\{(\d+)\}$/.exec(part)
      return found && Number(found[1]) < values.length ? values[Number(found[1])] : part
    }),
  )
}
