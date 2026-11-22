// 直しの案（tools/fix-extras.mjs）を、直す前と後を見くらべるページ（1 つの HTML）に書き出す。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { countChars } from '../../src/shared/essay.ts'

const LINK = /[\[［]([^\]］]{1,80})[\]］]\((https?:\/\/[^\s)]+)\)/g
export const rich = (text) => esc(text).replace(LINK, (_, label, url) => `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`)
export const esc = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/** 1 字ずつくらべて、「同じ」「消した・足した」のまとまりにする */
function diff(a, b) {
  const A = [...a]
  const B = [...b]
  let head = 0
  while (head < A.length && head < B.length && A[head] === B[head]) head += 1
  let tail = 0
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail += 1
  const X = A.slice(head, A.length - tail)
  const Y = B.slice(head, B.length - tail)
  const w = Y.length + 1
  const table = new Uint16Array((X.length + 1) * w)
  for (let i = X.length - 1; i >= 0; i -= 1) for (let j = Y.length - 1; j >= 0; j -= 1) table[i * w + j] = X[i] === Y[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1])
  const blocks = []
  const push = (type, ch) => {
    const last = blocks.at(-1)
    if (type === 0) {
      if (last && last.eq !== undefined) last.eq += ch
      else blocks.push({ eq: ch })
    } else if (last && last.eq === undefined) last[type < 0 ? 'del' : 'ins'] += ch
    else blocks.push({ del: type < 0 ? ch : '', ins: type > 0 ? ch : '' })
  }
  if (head) push(0, A.slice(0, head).join(''))
  let i = 0
  let j = 0
  while (i < X.length && j < Y.length) {
    if (X[i] === Y[j]) {
      push(0, X[i])
      i += 1
      j += 1
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) push(-1, X[i++])
    else push(1, Y[j++])
  }
  while (i < X.length) push(-1, X[i++])
  while (j < Y.length) push(1, Y[j++])
  if (tail) push(0, A.slice(A.length - tail).join(''))
  // 変更にはさまれた、ごく短い「同じ」は、変更にふくめる（1 字ずつ細かく切れると読みにくい）
  const out = []
  blocks.forEach((block, k) => {
    const last = out.at(-1)
    const next = blocks[k + 1]
    if (block.eq !== undefined && [...block.eq].length <= 2 && last && last.eq === undefined && next && next.eq === undefined) {
      last.del += block.eq
      last.ins += block.eq
    } else if (block.eq === undefined && last && last.eq === undefined) {
      last.del += block.del
      last.ins += block.ins
    } else out.push({ ...block })
  })
  return out
}

/** 直す前と後を、1 つの文の中に色で示す。大きく書きかえたときは、前と後を上下に並べる */
export function compare(before, after) {
  const a = String(before ?? '')
  const b = String(after ?? '')
  if (a === b) return ''
  const blocks = diff(a, b)
  const changed = blocks.reduce((n, x) => n + (x.eq === undefined ? [...x.del].length + [...x.ins].length : 0), 0)
  if (changed > ([...a].length + [...b].length) * 0.55) return `<div class="old">${esc(a) || '（なし）'}</div><div class="new">${esc(b) || '（なし）'}</div>`
  return `<div class="mix">${blocks.map((x) => (x.eq !== undefined ? esc(x.eq) : `${x.del ? `<del>${esc(x.del)}</del>` : ''}${x.ins ? `<ins>${esc(x.ins)}</ins>` : ''}`)).join('')}</div>`
}

const FIELDS = {
  term: [
    ['reading', '読み'],
    ['aliases', '別名'],
    ['short', '簡単な説明'],
    ['detail', 'くわしい説明'],
  ],
  short: [
    ['question', '問い'],
    ['answer', '解答例'],
    ['points', '採点の要点'],
  ],
  long: [
    ['question', '問い'],
    ['intro', '序論'],
    ['body', '本論'],
    ['conclusion', '結論'],
    ['points', '採点の要点'],
  ],
}
const show = (field, value) => (field === 'aliases' ? (value ?? []).join('、') : field === 'points' ? (value ?? []).map((p) => `・${p}`).join('\n') : String(value ?? ''))
const answerLength = (kind, item) => (kind === 'short' ? countChars(item.answer) : kind === 'long' ? countChars(`${item.intro}${item.body}${item.conclusion}`) : 0)

const GROUPS = [
  ['es', '小学校'],
  ['deep', '小学校（学び直し版）'],
  ['jhs', '中学校'],
  ['hs', '高校'],
  ['hsp', '高校（専門）'],
]
const groupOf = (r) => (r.meta.school === 'es' && r.meta.deep ? 'deep' : r.meta.school)
const BADGE = { 採用: 'adopt', 一部採用: 'part', 不採用: 'reject' }

function itemHtml(record, item) {
  const kind = item.kind === 'term' ? 'term' : 'essay'
  const findings = record.findings.filter((f) => f.kind === kind && f.target === item.target)
  const rows = findings.map((f) => {
    const v = record.verdicts[f.id]
    const badge = f.level === 'length' ? '<span class="badge len">字数</span>' : v ? `<span class="badge ${BADGE[v.verdict]}">${v.verdict}</span>` : '<span class="badge none">判定なし</span>'
    return `<li>${badge}<span class="part">${esc(f.part)}</span>${f.sure ? '' : '<span class="unsure">検査役は「自信なし」</span>'}
      <div class="what">${rich(f.what)}${f.level === 'length' ? '' : `<span class="how">直し方の案: ${esc(f.fix)}</span>`}</div>
      ${v ? `<div class="why">判定の理由: ${esc(v.reason)}${v.bodyAlso ? ' <b class="body-also">授業の本文にも同じ誤りがあります</b>' : ''}</div>` : ''}</li>`
  })
  let body = ''
  if (item.remove) body = '<p class="note">この用語は、用語集から外します。</p>'
  else if (item.after) {
    const fields = FIELDS[item.kind].map(([field, label]) => [label, compare(show(field, item.before[field]), show(field, item.after[field]))]).filter(([, html]) => html)
    const lengths = item.kind === 'term' || answerLength(item.kind, item.before) === answerLength(item.kind, item.after) ? '' : `<p class="count">解答例の字数: ${answerLength(item.kind, item.before)} 字 → ${answerLength(item.kind, item.after)} 字</p>`
    body = fields.length ? `${fields.map(([label, html]) => `<div class="field"><div class="label">${label}</div>${html.replaceAll('\n', '<br>')}</div>`).join('')}${lengths}` : '<p class="note">採用しましたが、文は変わっていません。</p>'
  } else if (item.status === 'kept') {
    body = `<details><summary>いまの文を見る（変えません）</summary>${FIELDS[item.kind].map(([field, label]) => `<div class="field"><div class="label">${label}</div><div class="plain">${esc(show(field, item.before[field])).replaceAll('\n', '<br>') || '（なし）'}</div></div>`).join('')}</details>`
  }
  const held = item.problems?.length ? `<p class="held">保留（機械の確かめに通らないので、入れません）: ${item.problems.map(esc).join('／')}</p>` : ''
  const cautions = item.cautions?.length ? `<p class="caution">注意: ${item.cautions.map(esc).join('／')}</p>` : ''
  return `<div class="item"><h3>${esc(item.label)}</h3><ul class="findings">${rows.join('')}</ul>${held}${cautions}${body}</div>`
}

/** ページの見た目（明るい画面・暗い画面の両方） */
export const STYLE = `:root { --bg: #f6f5f1; --card: #ffffff; --ink: #1f2328; --soft: #5c6470; --line: #dcd9d0; --del-bg: #fde3e1; --del-ink: #9b1c13; --ins-bg: #dcf3e2; --ins-ink: #0d5c2b; --adopt: #17783c; --part: #9a6200; --reject: #5c6470; --len: #1d5fa8; --warn-bg: #fff4d6; --warn-ink: #7a5200; --accent: #2a5db0; }
@media (prefers-color-scheme: dark) { :root { --bg: #16181c; --card: #1f2227; --ink: #e6e8eb; --soft: #9aa3ad; --line: #353a42; --del-bg: #4a1f1c; --del-ink: #ffb4ab; --ins-bg: #173a24; --ins-ink: #9fe3b5; --adopt: #6fd08c; --part: #e3b455; --reject: #9aa3ad; --len: #7fb4f0; --warn-bg: #3d3212; --warn-ink: #f0d58a; --accent: #8ab4f8; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.75 "Yu Gothic UI", "Hiragino Sans", "Noto Sans JP", "Meiryo", sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 28px 16px 80px; overflow-wrap: anywhere; }
a { color: var(--accent); }
.scroll { overflow-x: auto; margin-bottom: 18px; }
.scroll table { margin-bottom: 0; min-width: 520px; }
h1 { font-size: 24px; margin: 0 0 6px; }
.lead { color: var(--soft); margin: 0 0 20px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-bottom: 18px; }
.tile { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.tile b { display: block; font-size: 22px; line-height: 1.3; font-variant-numeric: tabular-nums; }
.tile span { color: var(--soft); font-size: 13px; }
table { border-collapse: collapse; width: 100%; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; margin-bottom: 18px; font-variant-numeric: tabular-nums; }
th, td { white-space: nowrap; padding: 7px 10px; border-bottom: 1px solid var(--line); text-align: right; font-weight: normal; }
tr:last-child th, tr:last-child td { border-bottom: 0; }
thead th { color: var(--soft); font-size: 13px; }
th:first-child { text-align: left; }
.guide { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; margin-bottom: 18px; }
.guide ul { margin: 4px 0 0; padding-left: 20px; }
.filters { position: sticky; top: 0; z-index: 2; background: var(--bg); padding: 10px 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; border-bottom: 1px solid var(--line); margin-bottom: 16px; }
.filters span { color: var(--soft); font-size: 13px; margin: 0 4px 0 8px; }
.filters span:first-child { margin-left: 0; }
button { font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; }
button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
@media (prefers-color-scheme: dark) { button[aria-pressed="true"] { color: #10141a; } }
#shown { margin-left: auto; color: var(--soft); font-size: 13px; }
.lesson { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px 6px; margin-bottom: 16px; }
.lesson h2 { font-size: 16px; margin: 0 0 10px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
.lesson h2 .title { font-weight: normal; }
.key { color: var(--soft); font-size: 12px; font-weight: normal; font-family: Consolas, monospace; margin-left: auto; }
.item { border-top: 1px solid var(--line); padding: 12px 0 10px; }
.item h3 { font-size: 15px; margin: 0 0 6px; }
.findings { list-style: none; margin: 0 0 8px; padding: 0; }
.findings li { margin-bottom: 8px; }
.badge { display: inline-block; font-size: 12px; font-weight: bold; padding: 0 8px; border-radius: 999px; border: 1px solid currentColor; margin-right: 8px; line-height: 1.6; }
.adopt { color: var(--adopt); } .part { color: var(--part); } .reject { color: var(--reject); } .len { color: var(--len); } .none { color: var(--del-ink); }
span.part { color: var(--ink); font-weight: bold; margin-right: 8px; }
.unsure { color: var(--soft); font-size: 12px; }
.what { margin-top: 2px; }
.how { display: block; color: var(--soft); font-size: 13px; }
.why { margin-top: 2px; padding-left: 10px; border-left: 3px solid var(--line); font-size: 14px; }
.body-also { color: var(--warn-ink); background: var(--warn-bg); padding: 0 6px; border-radius: 4px; }
.field { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 4px 10px; margin: 6px 0; }
.label { color: var(--soft); font-size: 13px; padding-top: 2px; }
.mix, .old, .new, .plain { grid-column: 2; overflow-wrap: anywhere; }
del { background: var(--del-bg); color: var(--del-ink); text-decoration: line-through; border-radius: 3px; padding: 0 1px; }
ins { background: var(--ins-bg); color: var(--ins-ink); text-decoration: none; border-radius: 3px; padding: 0 1px; }
.old { background: var(--del-bg); color: var(--del-ink); border-radius: 6px; padding: 4px 8px; }
.new { background: var(--ins-bg); color: var(--ins-ink); border-radius: 6px; padding: 4px 8px; }
.old::before { content: "前 "; font-weight: bold; } .new::before { content: "後 "; font-weight: bold; }
.count, .note { color: var(--soft); font-size: 13px; margin: 4px 0; }
.held, .caution { background: var(--warn-bg); color: var(--warn-ink); border-radius: 6px; padding: 4px 10px; font-size: 13px; margin: 6px 0; }
details { margin: 4px 0; } summary { cursor: pointer; color: var(--accent); font-size: 13px; }
@media (max-width: 600px) { .field { grid-template-columns: 1fr; } .mix, .old, .new, .plain { grid-column: 1; } .key { margin-left: 0; } }
`

export function writePage(file, records) {
  records.sort((a, b) => GROUPS.findIndex(([id]) => id === groupOf(a)) - GROUPS.findIndex(([id]) => id === groupOf(b)) || a.key.localeCompare(b.key, 'ja', { numeric: true }))
  const verdictsOf = (list) => {
    const out = { 採用: 0, 一部採用: 0, 不採用: 0, 字数: 0, 判定なし: 0 }
    for (const r of list) for (const f of r.findings) out[f.level === 'length' ? '字数' : (r.verdicts[f.id]?.verdict ?? '判定なし')] += 1
    return out
  }
  const all = verdictsOf(records)
  const judged = all.採用 + all.一部採用 + all.不採用
  const percent = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—')
  const items = records.flatMap((r) => r.changes)
  const count = (f) => items.filter(f).length
  const cost = records.reduce((n, r) => n + r.cost, 0)
  const seconds = records.reduce((n, r) => n + r.seconds, 0)
  const table = GROUPS.map(([id, label]) => {
    const list = records.filter((r) => groupOf(r) === id)
    const v = verdictsOf(list)
    return list.length ? `<tr><th>${label}</th><td>${list.length}</td><td>${v.採用}</td><td>${v.一部採用}</td><td>${v.不採用}</td><td>${percent(v.不採用, v.採用 + v.一部採用 + v.不採用)}</td><td>${v.字数}</td></tr>` : ''
  }).join('')
  const sections = records.map((r) => {
    const rejected = Object.values(r.verdicts).some((v) => v.verdict === '不採用')
    const held = r.changes.some((c) => c.status === 'held')
    const bodyAlso = Object.values(r.verdicts).some((v) => v.bodyAlso)
    return `<section class="lesson" data-group="${groupOf(r)}" data-reject="${rejected ? 1 : 0}" data-held="${held ? 1 : 0}" data-body="${bodyAlso ? 1 : 0}">
<h2>${esc(r.meta.course)}<span class="title">${esc(r.meta.lesson)}${r.meta.deep ? '（学び直し版）' : ''}</span><span class="key">${esc(r.key)}</span></h2>
${r.changes.map((item) => itemHtml(r, item)).join('\n')}
</section>`
  })
  const first = records[0]
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>直しの試し</title>
<style>
${STYLE}</style>
</head>
<body>
<main>
<h1>直しの試し</h1>
<p class="lead">検査役（Codex）の指摘を、別の AI（Claude ${esc(first?.model ?? '')}・思考量 ${esc(first?.effort ?? '')}）が 1 件ずつ確かめて、採用したものだけを直した案です。教材は、まだ書きかえていません。</p>
<div class="tiles">
<div class="tile"><b>${records.length} 件</b><span>授業</span></div>
<div class="tile"><b>${judged} 件</b><span>誤りの指摘（判定したもの）</span></div>
<div class="tile"><b>${percent(all.採用 + all.一部採用, judged)}</b><span>採用 ${all.採用}・一部採用 ${all.一部採用}</span></div>
<div class="tile"><b>${percent(all.不採用, judged)}</b><span>不採用 ${all.不採用}</span></div>
<div class="tile"><b>${count((c) => c.status === 'ok')} 個</b><span>直した用語・問題（保留 ${count((c) => c.status === 'held')}）</span></div>
<div class="tile"><b>${(cost / Math.max(1, records.length)).toFixed(3)} ドル</b><span>1 授業あたり（API 換算。合計 ${cost.toFixed(2)} ドル）</span></div>
</div>
<div class="scroll"><table>
<thead><tr><th>学校</th><th>授業</th><th>採用</th><th>一部採用</th><th>不採用</th><th>不採用の割合</th><th>字数の直し</th></tr></thead>
<tbody>${table}</tbody>
</table></div>
<div class="guide"><b>見るところ</b>
<ul>
<li>「不採用」の理由がもっともか（直したほうがよい指摘を落としていないか）。</li>
<li>直した後の文が、その学年に合っているか。<del>赤</del>が消した字、<ins>緑</ins>が足した字です。</li>
<li>1 授業あたりの時間は 平均 ${Math.round(seconds / Math.max(1, records.length))} 秒でした。</li>
</ul></div>
<div class="filters">
<span>学校</span><button data-filter="group" data-value="" aria-pressed="true">すべて</button>${GROUPS.filter(([id]) => records.some((r) => groupOf(r) === id)).map(([id, label]) => `<button data-filter="group" data-value="${id}" aria-pressed="false">${label}</button>`).join('')}
<span>しぼる</span><button data-filter="flag" data-value="" aria-pressed="true">すべて</button><button data-filter="flag" data-value="reject" aria-pressed="false">不採用あり</button><button data-filter="flag" data-value="held" aria-pressed="false">保留あり</button><button data-filter="flag" data-value="body" aria-pressed="false">本文にも誤り</button>
<span id="shown"></span>
</div>
${sections.join('\n')}
</main>
<script>
const state = { group: '', flag: '' }
function apply() {
  let shown = 0
  for (const s of document.querySelectorAll('.lesson')) {
    const ok = (!state.group || s.dataset.group === state.group) && (!state.flag || s.dataset[state.flag] === '1')
    s.hidden = !ok
    if (ok) shown += 1
  }
  document.getElementById('shown').textContent = shown + ' 件を表示'
}
for (const b of document.querySelectorAll('button[data-filter]')) {
  b.addEventListener('click', () => {
    state[b.dataset.filter] = b.dataset.value
    for (const o of document.querySelectorAll('button[data-filter="' + b.dataset.filter + '"]')) o.setAttribute('aria-pressed', String(o === b))
    apply()
  })
}
apply()
</script>
</body>
</html>
`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, html, 'utf8')
}
