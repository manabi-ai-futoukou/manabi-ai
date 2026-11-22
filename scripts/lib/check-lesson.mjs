// 授業 1 つの本文を機械的に検査する（書式・数式・図のブロック）。内容の正しさは見ない。
// 使うのは scripts/check-lessons.mjs（まとめて調べる）と tools/deepen-lessons.mjs（掘り下げた版を調べる）。
import katex from 'katex'
import { parsePicture } from '../../src/shared/blocks.ts'
import { FIGURE_ATTRIBUTES, FIGURE_ELEMENTS, compileExpression, safeFigureValue } from '../../src/shared/figures.ts'
import { normalizeSim } from '../../src/shared/sims.ts'

// 小学校の低学年向けは、見出しがひらがなで書かれている（「たしかめもんだい」「こたえ」など）
const REQUIRED = [
  ['ねらい', /^## .*ねらい/m],
  ['確かめ問題', /^## .*(確かめ|たしかめ|考えてみ|かんがえてみ)/m],
  ['答え', /^###? .*(答え|こたえ|考えるヒント|かんがえるヒント)/m],
  ['ノートに書いてみましょう', /^## .*ノート/m],
]
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)

/** 1 つの授業を調べて、見つかった問題を返す。level は error（表示が壊れる・決まりに反する）か warn（確認したほうがよい）。 */
export function checkLesson(body) {
  const found = []
  const add = (level, message) => found.push({ level, message })

  if (!/^# .+/.test(body)) add('error', '1 行目が「# タイトル」になっていない')
  for (const [name, pattern] of REQUIRED) if (!pattern.test(body)) add('error', `見出し「${name}」が無い`)
  if (/<(?!svg|\/svg|g\b|\/g>|line|rect|circle|ellipse|polygon|polyline|path|text|\/text|tspan|\/tspan|defs|\/defs|marker|\/marker|title|\/title)[a-z][^>]*>/i.test(body.replace(/```[\s\S]*?```/g, ''))) {
    add('warn', '本文に HTML のタグがある（表示されない）')
  }
  if ((body.match(/```/g) ?? []).length % 2) add('error', 'コードブロックの ``` が閉じていない')

  // 図のブロック
  for (const [, kind, raw] of body.matchAll(/```(numberline|plot|figure)\s*\n([\s\S]*?)```/g)) {
    const source = raw.trim()
    try {
      if (kind === 'numberline') {
        const spec = JSON.parse(source)
        if (!isNumber(spec.min) || !isNumber(spec.max) || spec.max <= spec.min) throw new Error('min・max が正しくない')
        for (const p of spec.points ?? []) if (!isNumber(p.at) || p.at < spec.min || p.at > spec.max) add('warn', `numberline: 点 ${p.at} が範囲の外`)
        for (const a of spec.arrows ?? []) if (![a.from, a.to].every(isNumber)) throw new Error('矢印の from・to が数でない')
      } else if (kind === 'plot') {
        const spec = JSON.parse(source)
        if (![spec.xMin, spec.xMax, spec.yMin, spec.yMax].every(isNumber) || spec.xMax <= spec.xMin || spec.yMax <= spec.yMin) throw new Error('範囲（xMin・xMax・yMin・yMax）が正しくない')
        for (const f of spec.functions ?? []) {
          const fn = compileExpression(String(f.expr))
          // 範囲の中で、グラフが 1 点も描けない式は、範囲か式がおかしい
          const visible = Array.from({ length: 41 }, (_, i) => fn(spec.xMin + ((spec.xMax - spec.xMin) * i) / 40)).some((y) => Number.isFinite(y) && y >= spec.yMin && y <= spec.yMax)
          if (!visible) add('warn', `plot: 式「${f.expr}」のグラフが、表示する範囲に入っていない`)
        }
        for (const p of spec.points ?? []) {
          if (!isNumber(p.x) || !isNumber(p.y)) throw new Error('点の x・y が数でない')
          if (p.x < spec.xMin || p.x > spec.xMax || p.y < spec.yMin || p.y > spec.yMax) add('warn', `plot: 点 (${p.x}, ${p.y}) が範囲の外`)
        }
      } else {
        if (!/^<svg[\s>]/.test(source) || !/<\/svg>\s*$/.test(source)) throw new Error('<svg> で始まり </svg> で終わっていない')
        if (!/viewBox=/.test(source)) add('warn', 'figure: viewBox が無い（大きさが合わないことがある）')
        for (const [, name] of source.matchAll(/<([a-zA-Z][\w:-]*)/g)) if (!FIGURE_ELEMENTS.has(name)) add('error', `figure: 使えない要素 <${name}>（表示されない）`)
        for (const [, name, , value] of source.matchAll(/\s([a-zA-Z][\w:-]*)=("|')(.*?)\2/g)) {
          if (!FIGURE_ATTRIBUTES.has(name)) add('warn', `figure: 使えない属性 ${name}（無視される）`)
          else if (!safeFigureValue(value)) add('error', `figure: 属性 ${name} の値が通らない`)
        }
      }
    } catch (error) {
      add('error', `${kind}: ${error.message}`)
    }
  }

  // 数式（KaTeX で組めるか）
  const prose = body.replace(/```[\s\S]*?```/g, '')
  const formulas = [...prose.matchAll(/\$\$([\s\S]+?)\$\$/g)].map((m) => m[1])
  formulas.push(...[...prose.replace(/\$\$[\s\S]+?\$\$/g, '').matchAll(/\$([^$\n]+?)\$/g)].map((m) => m[1]))
  for (const formula of formulas) {
    try {
      katex.renderToString(formula, { throwOnError: true, strict: false })
    } catch (error) {
      add('error', `数式を組めない: ${formula.trim().slice(0, 50)} — ${String(error.message).replace(/^KaTeX parse error: /, '').slice(0, 80)}`)
    }
  }
  if ((prose.replace(/\$\$[\s\S]+?\$\$/g, '').match(/\$/g) ?? []).length % 2) add('warn', '「$」の数が合わない（数式の閉じ忘れかもしれない）')

  // 掛け合い（1 行が「話し手(表情): せりふ」になっているか）
  for (const [, raw] of body.matchAll(/```talk\s*\n([\s\S]*?)```/g)) {
    const lines = raw.split('\n').filter((l) => l.trim())
    if (lines.length < 2) add('warn', '掛け合い: せりふが 1 つしかない')
    for (const l of lines) {
      if (!/^[^\s()（）:：、。「」]{1,16}\s*(?:[（(]\s*[A-Za-z]{1,16}\s*[)）])?\s*[:：]\s*\S/.test(l.trim())) add('error', `掛け合い: 「話し手(表情): せりふ」の形になっていない行 — ${l.trim().slice(0, 40)}`)
      else if (l.length > 220) add('warn', `掛け合い: せりふが長い（${l.length} 字）`)
    }
  }

  // 動く図解と挿絵（指定を読み取れるか。読み取れないものは、画面に出ない）
  for (const [, raw] of body.matchAll(/```sim\s*\n([\s\S]*?)```/g)) {
    let spec = null
    try {
      spec = normalizeSim(JSON.parse(raw))
    } catch {
      // 下で「読み取れない」として数える
    }
    if (!spec) add('error', '動く図解: 指定を読み取れない（表示されない）')
    else if (!spec.task) add('warn', '動く図解: 課題の文が無い')
  }
  for (const [, raw] of body.matchAll(/```picture\s*\n([\s\S]*?)```/g)) if (!parsePicture(raw.trim())) add('error', '挿絵: 指定を読み取れない（表示されない）')

  // 文体と体裁
  if (/(しなさい|せよ)[。．]/.test(prose)) add('warn', '命令の形（〜しなさい）がある。敬語（〜しましょう）にそろえる')
  if (body.length < 300) add('warn', `本文が短い（${body.length} 字）`)
  return found
}
