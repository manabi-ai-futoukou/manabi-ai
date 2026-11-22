// 画面の文言（日本語の文字列）を、言語を切りかえられる形（t('…') / tx('…')）に書きかえる。
//
//   node tools/i18n-wrap.mjs <ファイルかフォルダ>… [--write] [--errors-only]
//
// - JSX の中の文は、まわりの式や <b> などの小さな要素もふくめて 1 つの文にまとめ、tx('… {0} …', 値…) にする（訳で語順を変えられるように）。
// - それ以外の文字列・テンプレート文字列は t('… {0} …', 値…) にする。
// - 比較（===）や検索（includes・test など）、型、import、オブジェクトのキーに使っている文字列は、データなので書きかえない。
// - --errors-only を付けると、new Error(…) と dialog の文言だけを書きかえる（AI への指示文が混ざるファイル向け）。
// - --write を付けないと、書きかえずに、見つけた文言の一覧だけを出す。
import { parse } from '@babel/parser'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'

const args = process.argv.slice(2)
const write = args.includes('--write')
const errorsOnly = args.includes('--errors-only')
const root = resolve(import.meta.dirname, '..')
const targets = args.filter((a) => !a.startsWith('--')).map((a) => resolve(a))
const JA = /[぀-ヿ㐀-鿿]/
const walkDir = (p) => (statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walkDir(join(p, f))) : /\.(ts|tsx)$/.test(p) && !/\.d\.ts$/.test(p) ? [p] : [])

/** 文の途中に置ける小さな要素（これらは、文の中の値として 1 つの文にまとめる） */
const INLINE = new Set(['b', 'strong', 'em', 'i', 'span', 'code', 'kbd', 'small', 'a', 'u', 'mark', 'sub', 'sup', 'ruby', 'rt', 'abbr', 'q', 'cite', 'time'])
/** 中身がデータの属性（書きかえない） */
const SKIP_ATTR = /^(className|key|id|type|name|role|htmlFor|style|lang|src|href|value|defaultValue|data-.*)$/
/** 文字列をさがす・くらべるための関数（引数はデータ） */
const DATA_CALLS = new Set(['test', 'match', 'matchAll', 'replace', 'replaceAll', 'split', 'startsWith', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'has', 'get', 'delete', 'localeCompare', 'search', 'exec', 'querySelector', 'querySelectorAll', 'normalize'])

const quote = (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/ /g, '\\u00a0')}'`
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", hellip: '…', mdash: '—', ndash: '–', larr: '←', rarr: '→', times: '×' }
const decode = (text) => text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, name) => (name[0] === '#' ? String.fromCodePoint(name[1] === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))) : (ENTITIES[name] ?? whole)))
/** JSX の文字の空白の決まり（行ごとに前後の空白を落とし、空でない行を空白 1 つでつなぐ） */
function cleanJsxText(value) {
  const lines = value.split(/\r\n|\n|\r/)
  let out = ''
  let lastNonEmpty = 0
  lines.forEach((line, i) => /[^ \t]/.test(line) && (lastNonEmpty = i))
  lines.forEach((line, i) => {
    const first = i === 0
    const last = i === lines.length - 1
    let trimmed = line.replace(/\t/g, ' ')
    if (!first) trimmed = trimmed.replace(/^ +/, '')
    if (!last) trimmed = trimmed.replace(/ +$/, '')
    if (trimmed) out += trimmed + (i !== lastNonEmpty ? ' ' : '')
  })
  return decode(out)
}

const found = []
let changedFiles = 0

for (const file of targets.flatMap(walkDir)) {
  const src = readFileSync(file, 'utf8')
  if (!JA.test(src)) continue
  const ast = parse(src, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: false })
  const edits = []
  const rel = relative(root, file).replace(/\\/g, '/')
  let usesT = false
  let usesTx = false
  const note = (kind, message) => found.push({ file: rel, kind, message })

  /** [start, end) を、その中の書きかえを当てはめた文字列にする */
  function apply(start, end) {
    const inner = edits.filter((e) => e.start >= start && e.end <= end && !(e.start === start && e.end === end && e.whole)).sort((a, b) => a.start - b.start || b.end - a.end)
    let out = ''
    let at = start
    for (const e of inner) {
      if (e.start < at) continue // もっと外側の書きかえの中にあるもの
      out += src.slice(at, e.start) + e.make()
      at = e.end
    }
    return out + src.slice(at, end)
  }
  const hasJsx = (node) => {
    let yes = false
    visit(node, [], (n) => {
      if (n.type === 'JSXElement' || n.type === 'JSXFragment') yes = true
    })
    return yes
  }

  function visit(node, parents, fn) {
    if (!node || typeof node.type !== 'string') return
    fn(node, parents)
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'extra') continue
      const value = node[key]
      if (Array.isArray(value)) for (const child of value) child && typeof child.type === 'string' && visit(child, [...parents, { node, key }], fn)
      else if (value && typeof value.type === 'string') visit(value, [...parents, { node, key }], fn)
    }
  }

  /** この文字列は、表示する文言ではなくデータか */
  function isData(node, parents) {
    for (let i = parents.length - 1; i >= 0; i--) {
      const { node: p, key } = parents[i]
      const child = i === parents.length - 1 ? node : parents[i + 1].node
      if (p.type.startsWith('TS') && p.type !== 'TSAsExpression' && p.type !== 'TSNonNullExpression' && p.type !== 'TSSatisfiesExpression') return 'type'
      if ((p.type === 'ImportDeclaration' || p.type === 'ExportNamedDeclaration' || p.type === 'ExportAllDeclaration') && key === 'source') return 'import'
      if ((p.type === 'ObjectProperty' || p.type === 'ObjectMethod' || p.type === 'ClassProperty') && key === 'key' && !p.computed) return 'key'
      if (p.type === 'MemberExpression' && key === 'property') return 'key'
      if (p.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(p.operator) && (p.left === child || p.right === child)) return 'compare'
      if (p.type === 'SwitchCase' && key === 'test') return 'compare'
      if (p.type === 'TaggedTemplateExpression') return 'tag'
      if (p.type === 'CallExpression' || p.type === 'NewExpression' || p.type === 'OptionalCallExpression') {
        if (key !== 'arguments') continue
        const callee = p.callee
        const name = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression' ? callee.property?.name : ''
        if (name === 't' || name === 'tx') return 'done'
        if (name === 'RegExp') return 'regexp'
        if (DATA_CALLS.has(name) && callee.type !== 'Identifier') return 'search'
        if (callee.type === 'MemberExpression' && callee.object?.name === 'console') return 'log'
        // 関数の引数より外側は見ない（引数の中の文字列が、外側の比較に巻きこまれないように）
        return ''
      }
      if (p.type === 'ArrowFunctionExpression' || p.type === 'FunctionExpression' || p.type === 'FunctionDeclaration') return ''
      if (p.type === 'JSXAttribute') return SKIP_ATTR.test(p.name?.name ?? '') ? 'attr' : ''
    }
    return ''
  }
  /** --errors-only のとき: new Error(…) か dialog.…(…) の中か */
  function inErrorOrDialog(parents) {
    return parents.some(({ node: p }) => {
      if (p.type === 'NewExpression' && p.callee.type === 'Identifier' && /Error$/.test(p.callee.name)) return true
      if (p.type === 'CallExpression' && p.callee.type === 'MemberExpression' && p.callee.object?.name === 'dialog') return true
      return false
    })
  }

  const jsxDone = new Set()

  visit(ast.program, [], (node, parents) => {
    const parent = parents[parents.length - 1]?.node
    // ── JSX の子（文と、その中の値） ──
    if ((node.type === 'JSXElement' || node.type === 'JSXFragment') && !errorsOnly) {
      const kids = node.children
      const inline = (kid) => {
        if (kid.type === 'JSXText') return true
        if (kid.type === 'JSXExpressionContainer') return kid.expression.type !== 'JSXEmptyExpression'
        if (kid.type === 'JSXElement') {
          const name = kid.openingElement.name
          return name.type === 'JSXIdentifier' && INLINE.has(name.name)
        }
        return false
      }
      let i = 0
      while (i < kids.length) {
        if (!inline(kids[i])) {
          i++
          continue
        }
        let j = i
        while (j < kids.length && inline(kids[j])) j++
        let run = kids.slice(i, j)
        const before = i > 0
        const after = j < kids.length
        i = j
        const japanese = (kid) => (kid.type === 'JSXText' && JA.test(kid.value)) || (kid.type === 'JSXExpressionContainer' && kid.expression.type === 'StringLiteral' && JA.test(kid.expression.value))
        if (!run.some(japanese)) continue
        // 前後の、文字の無い空白だけの部分は外す
        while (run.length && run[0].type === 'JSXText' && !run[0].value.trim()) run = run.slice(1)
        while (run.length && run[run.length - 1].type === 'JSXText' && !run[run.length - 1].value.trim()) run = run.slice(0, -1)
        // 文字を 1 つもふくまない値（アイコンや別の部品）が端にあれば、文の外に出す
        while (run.length && run[0].type !== 'JSXText' && !japanese(run[0]) && run[0].type === 'JSXExpressionContainer' && hasJsx(run[0].expression)) run = run.slice(1)
        while (run.length && run[run.length - 1].type !== 'JSXText' && !japanese(run[run.length - 1]) && run[run.length - 1].type === 'JSXExpressionContainer' && hasJsx(run[run.length - 1].expression)) run = run.slice(0, -1)
        if (!run.some(japanese)) continue
        const start = run[0].start
        const end = run[run.length - 1].end
        const members = run
        for (const kid of members) jsxDone.add(kid)
        edits.push({
          start,
          end,
          make() {
            let message = ''
            const values = []
            members.forEach((kid, index) => {
              if (kid.type === 'JSXText') {
                // 両どなりが同じ行にあるときの空白は、文の一部として残す
                let text = kid.value
                const lines = text.split(/\r\n|\n|\r/)
                const firstInRun = index === 0
                const lastInRun = index === members.length - 1
                let cleaned = cleanJsxText(text)
                // 行をまたいでいても、となりに値があるなら、その間の空白は JSX では消える（そのまま）
                if (!firstInRun && lines.length === 1 && /^\s/.test(text) && !/^\s/.test(cleaned)) cleaned = ' ' + cleaned
                if (!lastInRun && lines.length === 1 && /\s$/.test(text) && !/\s$/.test(cleaned)) cleaned += ' '
                message += cleaned
              } else if (kid.type === 'JSXExpressionContainer' && kid.expression.type === 'StringLiteral') {
                message += kid.expression.value
              } else {
                message += `{${values.length}}`
                values.push(kid.type === 'JSXExpressionContainer' ? apply(kid.expression.start, kid.expression.end) : apply(kid.start, kid.end))
              }
            })
            const lead = /^\s/.test(message) && before ? "{' '}" : ''
            const trail = /\s$/.test(message) && after ? "{' '}" : ''
            message = message.trim()
            note(values.length ? 'tx' : 't', message)
            if (values.length) {
              usesTx = true
              return `${lead}{tx(${quote(message)}, ${values.join(', ')})}${trail}`
            }
            usesT = true
            return `${lead}{t(${quote(message)})}${trail}`
          },
        })
      }
      return
    }
    // ── 属性 ──
    if (node.type === 'JSXAttribute' && node.value?.type === 'StringLiteral' && JA.test(node.value.value) && !errorsOnly) {
      if (SKIP_ATTR.test(node.name.name ?? '')) return note('skip:attr', node.value.value)
      const value = node.value
      edits.push({
        start: value.start,
        end: value.end,
        whole: true,
        make() {
          usesT = true
          note('t', decode(value.value))
          return `{t(${quote(decode(value.value))})}`
        },
      })
      return
    }
    // ── 文字列 ──
    if (node.type === 'StringLiteral' && JA.test(node.value)) {
      if (parent?.type === 'JSXAttribute') return
      if (parent?.type === 'JSXExpressionContainer' && jsxDone.has(parent)) return
      const why = isData(node, parents)
      if (why) return void (why !== 'done' && note(`skip:${why}`, node.value))
      if (errorsOnly && !inErrorOrDialog(parents)) return note('skip:other', node.value)
      edits.push({
        start: node.start,
        end: node.end,
        whole: true,
        make() {
          usesT = true
          note('t', node.value)
          return `t(${quote(node.value)})`
        },
      })
      return
    }
    if (node.type === 'TemplateLiteral' && node.quasis.some((q) => JA.test(q.value.cooked ?? ''))) {
      const why = isData(node, parents)
      if (why) return void (why !== 'done' && note(`skip:${why}`, node.quasis.map((q) => q.value.cooked).join('${…}')))
      if (errorsOnly && !inErrorOrDialog(parents)) return note('skip:other', node.quasis.map((q) => q.value.cooked).join('${…}'))
      edits.push({
        start: node.start,
        end: node.end,
        whole: true,
        make() {
          let message = ''
          const values = []
          node.quasis.forEach((q, index) => {
            message += q.value.cooked
            const expression = node.expressions[index]
            if (expression) {
              message += `{${values.length}}`
              values.push(apply(expression.start, expression.end))
            }
          })
          usesT = true
          note('t', message)
          return `t(${quote(message)}${values.length ? ', ' + values.join(', ') : ''})`
        },
      })
    }
  })

  if (!edits.length) continue
  let out = apply(0, src.length)
  if (out === src) continue
  // import を足す
  const inShared = rel.startsWith('src/shared/')
  const inRenderer = rel.startsWith('src/renderer/')
  const names = []
  if (usesT && !/\bimport\b[^\n]*\bt\b[^\n]*from ['"][^'"]*i18n/.test(out)) names.push('t')
  if (usesTx) names.push('tx')
  if (names.length) {
    let from
    if (inShared) from = (relative(dirname(file), join(root, 'src/shared/i18n.ts')).replace(/\\/g, '/').replace(/^(?!\.)/, './'))
    else if (inRenderer) from = '@/lib/i18n'
    else from = '@shared/i18n'
    const line = `import { ${names.join(', ')} } from '${from}'\n`
    // 最後の import 文のあとに入れる
    const imports = ast.program.body.filter((n) => n.type === 'ImportDeclaration')
    if (imports.length) {
      const lastImport = imports[imports.length - 1]
      // out の中での位置を、元の位置までの書きかえを当てはめて求める
      const head = apply(0, lastImport.end)
      out = head + '\n' + line.trimEnd() + out.slice(head.length)
    } else out = line + out
  }
  changedFiles += 1
  if (write) writeFileSync(file, out, 'utf8')
}

const counts = {}
for (const f of found) counts[f.kind] = (counts[f.kind] ?? 0) + 1
console.log(`${write ? '書きかえた' : '書きかえる'}ファイル ${changedFiles}、文言`, counts)
if (args.includes('--list')) for (const f of found) console.log(`${f.kind}\t${f.file}\t${f.message.replace(/\n/g, '\\n').slice(0, 200)}`)
