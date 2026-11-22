// 本文の差しかえの案（tools/fix-bodies.mjs）を、直す前と後を見くらべるページ（1 つの HTML）に書き出す。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { STYLE, compare, esc, rich } from './fix-page.mjs'

const GROUPS = [
  ['deep', '小学校（学び直し版）'],
  ['es', '小学校'],
  ['jhs', '中学校'],
  ['hs', '高校'],
  ['hsp', '高校（専門）'],
]
const groupOf = (r) => (r.meta.school === 'es' && r.meta.deep ? 'deep' : r.meta.school)
const VERDICT = { 誤りがある: 'adopt', 直さない: 'reject', 本文には無い: 'reject' }
const CHECK = { ok: ['adopt', 'Codex: 正しい'], wrong: ['none', 'Codex: 直した文に誤り'], unneeded: ['part', 'Codex: 直す必要なし'] }
/** 教材に入れる候補か（機械の確かめを通り、Codex が「正しい」とした差しかえ） */
export const passes = (edit) => edit.status === 'ok' && edit.check?.verdict === 'ok' && !edit.skip

function editHtml(record, edit) {
  const about = edit.ids.map((id) => `[${id}]`).join(' ')
  const check = edit.check ? `<p class="check"><span class="badge ${CHECK[edit.check.verdict][0]}">${CHECK[edit.check.verdict][1]}</span>${edit.check.sure ? '' : '<span class="unsure">自信なし</span>'} ${rich(edit.check.reason)}</p>` : edit.status === 'ok' ? '<p class="check"><span class="badge len">Codex: まだ</span></p>' : ''
  const held = edit.problems?.length ? `<p class="held">保留（機械の確かめに通らないので、入れません）: ${edit.problems.map(esc).join('／')}</p>` : ''
  const skipped = edit.skip ? '<p class="caution">入れません: ' + esc(edit.skip) + '</p>' : ''
  const cautions = edit.cautions?.length ? `<p class="caution">注意: ${edit.cautions.map(esc).join('／')}</p>` : ''
  // その行の中で、どこが変わるか（行が長いときも、前後が分かるように、行ごと見せる）
  const line = edit.context && edit.context.includes(edit.old) ? compare(edit.context, edit.context.replace(edit.old, () => edit.new)) : compare(edit.old, edit.new)
  return `<div class="edit ${passes(edit) ? 'pass' : ''}"><div class="edit-head"><span class="where">${esc(edit.kind ?? '本文')}${edit.line ? `・${edit.line} 行目` : ''}</span><span class="about">指摘 ${about}</span>${passes(edit) ? '<span class="badge adopt">入れる候補</span>' : '<span class="badge reject">入れない</span>'}</div>
${line.replaceAll('\n', '<br>')}
${edit.note ? `<p class="note">直したこと: ${esc(edit.note)}</p>` : ''}${check}${skipped}${held}${cautions}</div>`
}

function lessonHtml(record) {
  const rows = record.findings.map((f) => {
    const v = record.verdicts[f.id]
    const block = record.blocks.find((b) => b.id === f.id)
    return `<li><span class="num">[${f.id}]</span>${v ? `<span class="badge ${VERDICT[v.verdict]}">${v.verdict}</span>` : '<span class="badge none">判定なし</span>'}<span class="part">${esc(f.kind === 'term' ? `用語「${f.target}」` : f.target)}・${esc(f.part)}</span>
      <div class="what">${rich(f.what)}<span class="how">直し方の案: ${esc(f.fix)}</span></div>
      ${v ? `<div class="why">本文を読んだ判定: ${esc(v.reason)}</div>` : ''}${block ? `<div class="held">図などのブロックの中（直しません）: ${esc(block.note)}</div>` : ''}</li>`
  })
  const edits = record.edits.map((e) => editHtml(record, e)).join('\n')
  const flags = { edit: record.edits.length ? 1 : 0, pass: record.edits.some(passes) ? 1 : 0, stop: record.edits.some((e) => e.status === 'ok' && e.check && e.check.verdict !== 'ok') ? 1 : 0, held: record.edits.some((e) => e.status === 'held') || record.blocks.length ? 1 : 0 }
  return `<section class="lesson" data-group="${groupOf(record)}" data-edit="${flags.edit}" data-pass="${flags.pass}" data-stop="${flags.stop}" data-held="${flags.held}">
<h2>${esc(record.meta.course)}<span class="title">${esc(record.meta.lesson)}${record.meta.deep ? '（学び直し版）' : ''}</span><span class="key">${esc(record.key)}</span></h2>
<div class="item"><ul class="findings">${rows.join('')}</ul></div>
${edits ? `<div class="item"><h3>差しかえ ${record.edits.length} か所</h3>${edits}</div>` : '<div class="item"><p class="note">本文は、変えません。</p></div>'}
</section>`
}

export function tallyBodies(records) {
  const out = { lessons: records.length, findings: 0, 誤りがある: 0, 直さない: 0, 本文には無い: 0, 判定なし: 0, edits: 0, ok: 0, held: 0, checked: 0, pass: 0, wrong: 0, unneeded: 0, unsure: 0, blocks: 0, touched: 0, cost: 0, seconds: 0 }
  for (const r of records) {
    out.cost += r.cost
    out.seconds += r.seconds
    out.blocks += r.blocks.length
    if (r.edits.some(passes)) out.touched += 1
    for (const f of r.findings) {
      out.findings += 1
      out[r.verdicts[f.id]?.verdict ?? '判定なし'] += 1
    }
    for (const e of r.edits) {
      out.edits += 1
      out[e.status] += 1
      if (e.status === 'ok' && e.check) {
        out.checked += 1
        out[e.check.verdict === 'ok' ? 'pass' : e.check.verdict] += 1
        if (!e.check.sure) out.unsure += 1
      }
    }
  }
  return out
}

export function writeBodyPage(file, records) {
  records.sort((a, b) => GROUPS.findIndex(([id]) => id === groupOf(a)) - GROUPS.findIndex(([id]) => id === groupOf(b)) || a.key.localeCompare(b.key, 'ja', { numeric: true }))
  const all = tallyBodies(records)
  const percent = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—')
  const table = GROUPS.map(([id, label]) => {
    const t = tallyBodies(records.filter((r) => groupOf(r) === id))
    return t.lessons ? `<tr><th>${label}</th><td>${t.lessons}</td><td>${t.findings}</td><td>${t.誤りがある}</td><td>${t.直さない}</td><td>${t.本文には無い}</td><td>${t.ok}</td><td>${t.pass}</td><td>${t.wrong}</td><td>${t.unneeded}</td><td>${t.held}</td></tr>` : ''
  }).join('')
  const first = records[0]
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>本文の直しの試し</title>
<style>
${STYLE}
.num { color: var(--soft); font-family: Consolas, monospace; font-size: 13px; margin-right: 6px; }
.edit { border: 1px solid var(--line); border-left: 4px solid var(--line); border-radius: 8px; padding: 8px 12px; margin: 8px 0; }
.edit.pass { border-left-color: var(--adopt); }
.edit-head { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; margin-bottom: 4px; font-size: 13px; }
.where { font-weight: bold; }
.about { color: var(--soft); }
.edit-head .badge { margin-left: auto; margin-right: 0; }
.check { margin: 6px 0 2px; font-size: 14px; }
.edit .mix, .edit .old, .edit .new { overflow-wrap: anywhere; }
.edit .old, .edit .new { margin: 4px 0; }
</style>
</head>
<body>
<main>
<h1>本文の直しの試し</h1>
<p class="lead">用語集・問題の検査で「授業の本文にも同じ誤りがある」と印の付いた指摘を、別の AI（Claude ${esc(first?.model ?? '')}・思考量 ${esc(first?.effort ?? '')}）が本文と読みくらべ、誤りの文だけを差しかえる案です。差しかえは、検査役（Codex）が 1 件ずつ確かめました。教材は、まだ書きかえていません。</p>
<div class="tiles">
<div class="tile"><b>${all.lessons} 件</b><span>授業（印の付いた指摘 ${all.findings} 件）</span></div>
<div class="tile"><b>${percent(all.誤りがある, all.findings)}</b><span>本文に誤りがある ${all.誤りがある} 件</span></div>
<div class="tile"><b>${percent(all.直さない + all.本文には無い, all.findings)}</b><span>直さない ${all.直さない}・本文には無い ${all.本文には無い}</span></div>
<div class="tile"><b>${all.ok} か所</b><span>差しかえの案（保留 ${all.held}）</span></div>
<div class="tile"><b>${all.pass} か所</b><span>Codex が「正しい」（${percent(all.pass, all.checked)}）＝ 入れる候補</span></div>
<div class="tile"><b>${all.wrong + all.unneeded} か所</b><span>Codex が通さなかった（誤り ${all.wrong}・直す必要なし ${all.unneeded}）</span></div>
<div class="tile"><b>${all.touched} 件</b><span>本文が変わる授業</span></div>
<div class="tile"><b>${(all.cost / Math.max(1, all.lessons)).toFixed(3)} ドル</b><span>1 授業あたり（Claude。合計 ${all.cost.toFixed(2)} ドル）</span></div>
</div>
<div class="scroll"><table>
<thead><tr><th>学校</th><th>授業</th><th>指摘</th><th>誤りがある</th><th>直さない</th><th>本文には無い</th><th>差しかえ</th><th>Codex 正しい</th><th>誤り</th><th>必要なし</th><th>保留</th></tr></thead>
<tbody>${table}</tbody>
</table></div>
<div class="guide"><b>見るところ</b>
<ul>
<li>「入れる候補」の差しかえが、正しく、その学年に合っているか。<del>赤</del>が消した字、<ins>緑</ins>が足した字です（その行をまるごと出しています）。</li>
<li>「直さない」「本文には無い」とした判定がもっともか（直したほうがよい誤りを落としていないか）。</li>
<li>Codex が通さなかった差しかえは、入れません。理由がもっともかを見てください。</li>
</ul></div>
<div class="filters">
<span>学校</span><button data-filter="group" data-value="" aria-pressed="true">すべて</button>${GROUPS.filter(([id]) => records.some((r) => groupOf(r) === id)).map(([id, label]) => `<button data-filter="group" data-value="${id}" aria-pressed="false">${label}</button>`).join('')}
<span>しぼる</span><button data-filter="flag" data-value="" aria-pressed="true">すべて</button><button data-filter="flag" data-value="pass" aria-pressed="false">本文が変わる</button><button data-filter="flag" data-value="stop" aria-pressed="false">Codex が通さなかった</button><button data-filter="flag" data-value="held" aria-pressed="false">保留・ブロックの中</button>
<span id="shown"></span>
</div>
${records.map(lessonHtml).join('\n')}
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
