/**
 * AI の返答には「[表情:smile] こんにちは。」のように表情タグが付く（日本語以外の指示文では [expression:smile]）。
 * 先頭に 1 つだけ付けるよう頼んでいるが、話の途中で表情を変えるために
 * 2 つ目のタグを入れてくることがあるので、タグは場所を問わずすべて本文から取り除き、
 * いちばん後ろのタグを「いまの表情」として返す。
 * 文字が少しずつ届く途中でも表示できるよう、末尾の書きかけのタグは隠す。
 */
export function splitExpression(raw: string): { expression: string | null; text: string } {
  let expression: string | null = null
  const text = raw
    .replace(/\[(?:表情|expression)[:：]\s*([a-z_]+)\s*\][ \t]*/gi, (_tag, name: string) => {
      expression = name.toLowerCase()
      return ''
    })
    // 「[表情:smi」のように、閉じ括弧がまだ届いていない末尾
    .replace(/\[(?:表(?:情(?:[:：]\s*[a-z_]*)?)?)?$/i, '')
    // 英語の指示文のときの「[expression:smi」「[expr」のような書きかけ
    .replace(/\[([a-z]{1,10})(?:[:：]\s*[a-z_]*)?$/i, (whole, word: string) => ('expression'.startsWith(word.toLowerCase()) ? '' : whole))
    .replace(/^\s+/, '')
  return { expression, text }
}
