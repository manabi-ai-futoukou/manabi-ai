// 直しの案（tools/fix-extras.mjs）のまとめを、文章のファイル（Markdown）に書き出す。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const GROUPS = [
  ['es', '小学校'],
  ['deep', '小学校（学び直し版）'],
  ['jhs', '中学校'],
  ['hs', '高校'],
  ['hsp', '高校（専門）'],
]
const groupOf = (r) => (r.meta.school === 'es' && r.meta.deep ? 'deep' : r.meta.school)
const flat = (text) => String(text ?? '').replace(/\s*\n\s*/g, ' ').trim()
const nameOf = (f) => (f.kind === 'term' ? `用語「${f.target}」` : f.target)
const percent = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—')

function tally(records) {
  const out = { lessons: records.length, 採用: 0, 一部採用: 0, 不採用: 0, 判定なし: 0, 字数: 0, terms: 0, problems: 0, removed: 0, held: 0, same: 0, body: 0, applied: 0, cost: 0, seconds: 0 }
  for (const r of records) {
    out.cost += r.cost
    out.seconds += r.seconds
    if (r.appliedAt) out.applied += 1
    if (Object.values(r.verdicts).some((v) => v.bodyAlso)) out.body += 1
    for (const f of r.findings) out[f.level === 'length' ? '字数' : (r.verdicts[f.id]?.verdict ?? '判定なし')] += 1
    for (const c of r.changes) {
      if (c.status === 'held') out.held += 1
      else if (c.status === 'same') out.same += 1
      else if (c.status === 'ok' && c.remove) out.removed += 1
      else if (c.status === 'ok') out[c.kind === 'term' ? 'terms' : 'problems'] += 1
    }
  }
  return out
}

/** records: 案の記録。info: { targets（直すものがある授業の数）, backup } */
export function writeReport(dir, records, info) {
  mkdirSync(dir, { recursive: true })
  records.sort((a, b) => GROUPS.findIndex(([id]) => id === groupOf(a)) - GROUPS.findIndex(([id]) => id === groupOf(b)) || a.key.localeCompare(b.key, 'ja', { numeric: true }))
  const all = tally(records)
  const judged = all.採用 + all.一部採用 + all.不採用
  const first = records[0]
  const md = ['# 用語集と記述・論述の直し（まとめ）', '']
  md.push(`- 書き出した日: ${new Date().toLocaleString('ja-JP')}`)
  md.push(`- 直した役: Claude（${first?.model ?? ''}・思考量 ${first?.effort ?? ''}）。検査役（Codex）の指摘を 1 件ずつ確かめ、採用したものだけを直しました。授業の本文は直していません。`)
  md.push(`- 案を作った授業: ${all.lessons} 件（直すものがある授業は ${info.targets} 件）。そのうち、教材に入れた授業: ${all.applied} 件`)
  md.push(`- かかった量: API 換算 約 ${all.cost.toFixed(0)} ドル（1 授業あたり ${(all.cost / Math.max(1, all.lessons)).toFixed(3)} ドル、平均 ${Math.round(all.seconds / Math.max(1, all.lessons))} 秒）`, '')
  md.push('## 指摘の判定', '')
  md.push('| 学校 | 授業 | 誤りの指摘 | 採用 | 一部採用 | 不採用 | 不採用の割合 | 字数の直し |', '|---|---:|---:|---:|---:|---:|---:|---:|')
  for (const [id, label] of GROUPS) {
    const t = tally(records.filter((r) => groupOf(r) === id))
    if (t.lessons) md.push(`| ${label} | ${t.lessons} | ${t.採用 + t.一部採用 + t.不採用 + t.判定なし} | ${t.採用} | ${t.一部採用} | ${t.不採用} | ${percent(t.不採用, t.採用 + t.一部採用 + t.不採用)} | ${t.字数} |`)
  }
  md.push(`| 合計 | ${all.lessons} | ${judged + all.判定なし} | ${all.採用} | ${all.一部採用} | ${all.不採用} | ${percent(all.不採用, judged)} | ${all.字数} |`, '')
  md.push('## 直したもの', '')
  md.push(`- 用語: ${all.terms} 個（ほかに、用語集から外した用語 ${all.removed} 個）`)
  md.push(`- 記述・論述の問題: ${all.problems} 問`)
  md.push(`- 保留（機械の確かめに通らず、入れなかったもの）: ${all.held} 個`)
  md.push(`- 採用したが、文が変わらなかったもの: ${all.same} 個`)
  md.push(`- 判定が返ってこなかった指摘: ${all.判定なし} 件`)
  md.push(`- 「授業の本文にも同じ誤りがある」と付いた授業: ${all.body} 件（一覧は「本文にも誤りがある授業.md」）`, '')
  md.push('## 教科ごと', '')
  md.push('| 学校 | 教科 | 授業 | 誤りの指摘 | 不採用 | 直した用語 | 直した問題 | 保留 | 本文にも誤り |', '|---|---|---:|---:|---:|---:|---:|---:|---:|')
  const subjects = new Map()
  for (const r of records) {
    const id = `${groupOf(r)}|${r.meta.subject}`
    subjects.set(id, [...(subjects.get(id) ?? []), r])
  }
  for (const [id, list] of subjects) {
    const t = tally(list)
    md.push(`| ${GROUPS.find(([g]) => g === id.split('|')[0])[1]} | ${id.split('|')[1]} | ${t.lessons} | ${t.採用 + t.一部採用 + t.不採用 + t.判定なし} | ${t.不採用} | ${t.terms} | ${t.problems} | ${t.held} | ${t.body} |`)
  }
  md.push('', '## 読み方', '')
  md.push('- 「不採用」は、指摘のほうがまちがっている、または、その学年でふつうの簡略化だと判定したものです。理由は「不採用の一覧.md」にあります。')
  md.push(`- 直す前のファイルは ${info.backup} に残してあります。`)
  md.push('- 直しの案（直す前と後）は、道具の側のデータ置き場の fix/lessons/ にあります。科目ごとの見くらべのページは `node --no-warnings tools/fix-extras.mjs --page --courses 科目の ID` で作れます。')
  writeFileSync(join(dir, '直しのまとめ.md'), `${md.join('\n')}\n`, 'utf8')

  const listing = (title, lead, pick, line) => {
    const out = [`# ${title}`, '', lead, '']
    let course = ''
    let count = 0
    for (const r of records) {
      const rows = r.findings.filter((f) => pick(r, f))
      if (!rows.length) continue
      if (r.meta.course !== course) {
        course = r.meta.course
        out.push('', `## ${course}`)
      }
      out.push('', `### ${r.meta.lesson}${r.meta.deep ? '（学び直し版）' : ''}（${r.key}）`)
      for (const f of rows) {
        out.push(line(r, f))
        count += 1
      }
    }
    out[2] = `${lead}（${count} 件）`
    return `${out.join('\n')}\n`
  }
  writeFileSync(join(dir, '不採用の一覧.md'), listing('不採用にした指摘', '検査役（Codex）の指摘のうち、直す役（Claude）が採用しなかったものと、その理由です', (r, f) => r.verdicts[f.id]?.verdict === '不採用', (r, f) => `- **${nameOf(f)}・${f.part}**: ${flat(f.what)}\n  - 不採用の理由: ${flat(r.verdicts[f.id].reason)}`), 'utf8')
  writeFileSync(join(dir, '本文にも誤りがある授業.md'), listing('授業の本文にも同じ誤りがある、と判定された指摘', '用語・問題は直しましたが、授業の本文は直していません。本文を直すときの手がかりです', (r, f) => r.verdicts[f.id]?.bodyAlso === true, (r, f) => `- **${nameOf(f)}・${f.part}**: ${flat(f.what)}\n  - 直し方の案: ${flat(f.fix)}\n  - 判定（${r.verdicts[f.id].verdict}）: ${flat(r.verdicts[f.id].reason)}`), 'utf8')
  const held = records.flatMap((r) => r.changes.filter((c) => c.status === 'held').map((c) => `- ${r.meta.course} ${r.meta.lesson}（${r.key}）${c.label}: ${c.problems.join('／')}`))
  writeFileSync(join(dir, '保留の一覧.md'), `# 保留（機械の確かめに通らず、入れなかったもの）\n\n${held.length} 個。\n\n${held.join('\n')}\n`, 'utf8')
  return all
}
