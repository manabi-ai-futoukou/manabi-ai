import { t } from './i18n.ts'
/**
 * ショートカットキーの一覧と、キーの組み合わせの表し方。
 *
 * 組み合わせは「Ctrl+Shift+Space」のように、修飾キー（Ctrl・Shift・Alt）と、キーの位置を表す名前（KeyboardEvent.code）で表す。
 * 文字ではなく位置で覚えるのは、日本語入力がオンのときでも同じキーとして扱えるようにするため
 * （文字で見ると、日本語入力中は「M」が別の文字として届く）。
 */

export interface KeyAction {
  id: string
  label: string
  /** all: すべての画面で使う / note: ノートで使う */
  group: 'all' | 'note'
  /** 押している間だけ働く（ドラッグと組み合わせる） */
  hold?: boolean
  /** はじめの割り当て。空文字は「割り当てなし」 */
  fallback: string
}

export const KEY_ACTIONS: KeyAction[] = [
  { id: 'zoomIn', label: t('画面の表示を大きくする'), group: 'all', fallback: 'Ctrl+Semicolon' },
  { id: 'zoomOut', label: t('画面の表示を小さくする'), group: 'all', fallback: 'Ctrl+Minus' },
  { id: 'zoomReset', label: t('画面の表示を 100% にもどす'), group: 'all', fallback: 'Ctrl+Digit0' },
  { id: 'pinRight', label: t('この画面を、右に固定する'), group: 'all', fallback: 'Ctrl+Alt+ArrowRight' },
  { id: 'pinLeft', label: t('この画面を、左に固定する'), group: 'all', fallback: 'Ctrl+Alt+ArrowLeft' },
  { id: 'pinOff', label: t('画面の固定をやめる'), group: 'all', fallback: 'Ctrl+Alt+ArrowDown' },
  { id: 'noteUndo', label: t('元に戻す'), group: 'note', fallback: 'Ctrl+KeyZ' },
  { id: 'noteRedo', label: t('やり直す'), group: 'note', fallback: 'Ctrl+KeyY' },
  { id: 'noteClearPage', label: t('最後に触れたページの書きこみを、すべて消す'), group: 'note', fallback: 'Delete' },
  { id: 'notePrev', label: t('左のページ（前の見開き）へ'), group: 'note', fallback: 'ArrowLeft' },
  { id: 'noteNext', label: t('右のページ（次の見開き）へ'), group: 'note', fallback: 'ArrowRight' },
  { id: 'noteSelect', label: t('選択の道具に切りかえる'), group: 'note', fallback: 'KeyM' },
  { id: 'notePen', label: t('ペンに切りかえる'), group: 'note', fallback: '' },
  { id: 'noteEraser', label: t('消しゴムに切りかえる'), group: 'note', fallback: '' },
  { id: 'noteTyping', label: t('手書きとタイピングを切りかえる'), group: 'note', fallback: '' },
  { id: 'notePan', label: t('ページをつかんで動かす（押している間にドラッグ）'), group: 'note', hold: true, fallback: 'Space' },
  { id: 'noteZoom', label: t('ページを拡大・縮小する（押している間にドラッグ。右上へで拡大、左下へで縮小）'), group: 'note', hold: true, fallback: 'Ctrl+Shift+Space' },
]

export type KeyMap = Record<string, string>

/** 利用者が変えた割り当て（overrides）を、はじめの割り当てに重ねる */
export function resolveKeys(overrides: KeyMap | undefined): KeyMap {
  const map: KeyMap = {}
  for (const action of KEY_ACTIONS) map[action.id] = overrides?.[action.id] ?? action.fallback
  return map
}

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta)(Left|Right)$/

export const isModifierCode = (code: string) => MODIFIER_CODES.test(code)

/** 修飾キーの状態と、キーの位置の名前から、組み合わせの文字列を作る */
export function combo(mods: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, code: string): string {
  return [mods.ctrlKey && 'Ctrl', mods.shiftKey && 'Shift', mods.altKey && 'Alt', code].filter(Boolean).join('+')
}

const CODE_LABELS: Record<string, string> = {
  Space: t('スペース'),
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
  Semicolon: ';',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  NumpadAdd: t('テンキー +'),
  NumpadSubtract: t('テンキー -'),
}

/**
 * 組み合わせを、画面に出す形にする。
 * @param layout いま使っているキーボードの「位置 → 文字」の対応（分かるときだけ渡す。日本語配列と英語配列で記号の位置がちがうため）
 */
export function comboLabel(value: string, layout?: { get(code: string): string | undefined }): string {
  if (!value) return t('なし')
  const parts = value.split('+')
  const code = parts.pop()!
  const key =
    CODE_LABELS[code] ??
    (/^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : /^Numpad\d$/.test(code) ? t('テンキー {0}', code.slice(6)) : (layout?.get(code)?.toUpperCase() ?? code))
  return [...parts, key].join(' + ')
}

/** 画面の表示倍率の範囲（100%〜400%） */
export const ZOOM_MIN = 1
export const ZOOM_MAX = 4
export const clampZoom = (value: number) => Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(value) || 1)) * 100) / 100
