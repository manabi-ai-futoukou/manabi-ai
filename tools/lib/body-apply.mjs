// 本文の差しかえ（tools/fix-bodies.mjs）を、教材に入れる・まとめを書き出す。
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { passes, tallyBodies } from './body-page.mjs'

/** アプリが開いているか（開いているあいだは、授業のファイルを書かない）。確かめられないときは、開いているものとして扱う */
function appOpen() {
  const script = "(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'electron.exe' -or $_.Name -eq '学びアイ.exe') -and ($_.ExecutablePath -like '*学びアイ*' -or $_.CommandLine -like '*学びアイ*') } | Measure-Object).Count"
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
  return !(result.status === 0 && Number(String(result.stdout ?? '').trim()) === 0)
}

/**
 * 通った差しかえ（機械の確かめを通り、codex が「正しい」としたもの）を、授業の本文に入れる。
 * - 直す前の本文は、保管に写す（もう写してあれば、そのまま。いちばん古い形を残す）
 * - 案を作ったあとで本文が変わっていた授業には、入れない
 * - その授業の用語集（annot）・記述論述（essay）が持っている「本文の指紋（src）」も、新しい本文のものにする
 *   （そうしないと、annotate-lessons.mjs・make-essays.mjs を次に流したとき、直した用語集と問題が作り直されて消える）
 */
export async function applyBodies({ dataDir, lessonsDir, recordDir, works, hash, readJson, writeJson, log, dry, backup }) {
  // 写しのデータ置き場（MANABI_DATA_DIR）で試すときは、アプリとは別の場所なので、確かめない
  if (!dry && !process.env['MANABI_DATA_DIR'] && appOpen()) {
    log('アプリが開いているので、教材に入れません。アプリを閉じてから、もう一度実行してください。')
    return
  }
  const count = { lessons: 0, edits: 0, skipped: 0, stale: 0, none: 0, already: 0, nothing: 0, annot: 0, essay: 0 }
  for (const work of works) {
    const file = join(recordDir, `${work.key}.json`)
    const record = readJson(file, null)
    if (!record) {
      count.none += 1
      continue
    }
    if (record.appliedAt) {
      count.already += 1
      continue
    }
    const lessonFile = join(lessonsDir, `${work.key}.md`)
    const raw = readFileSync(lessonFile, 'utf8')
    let body = raw.replaceAll('\r\n', '\n')
    const before = hash(body)
    if (record.src !== work.src || record.bodySrc !== before) {
      count.stale += 1
      continue
    }
    const edits = record.edits.filter(passes)
    let applied = 0
    // うしろの差しかえから入れる（前の差しかえで、文字の位置がずれないように）
    for (const edit of [...edits].sort((a, b) => b.at - a.at)) {
      if (body.split(edit.old).length - 1 !== 1) {
        edit.skipped = '入れるときに、old が本文にちょうど 1 か所ではありませんでした'
        count.skipped += 1
        continue
      }
      body = body.replace(edit.old, () => edit.new)
      edit.applied = true
      applied += 1
    }
    if (!applied) {
      count.nothing += 1
      continue
    }
    const after = hash(body)
    count.lessons += 1
    count.edits += applied
    if (!dry) {
      const to = join(backup, 'lessons', `${work.key}.md`)
      mkdirSync(join(backup, 'lessons'), { recursive: true })
      if (!existsSync(to)) copyFileSync(lessonFile, to)
      writeFileSync(`${lessonFile}.tmp`, raw.includes('\r\n') ? body.replaceAll('\n', '\r\n') : body, 'utf8')
      renameSync(`${lessonFile}.tmp`, lessonFile)
    }
    for (const folder of ['annot', 'essay']) {
      const side = join(dataDir, folder, `${work.key}.json`)
      const data = readJson(side, null)
      // 指紋が直す前の本文と合っているときだけ、新しくする（合っていないものは、もともと古いので、さわらない）
      if (data?.src !== before) continue
      count[folder] += 1
      if (!dry) writeJson(side, { ...data, src: after })
    }
    if (!dry) writeJson(file, { ...record, appliedAt: new Date().toISOString(), bodyAfter: after }, true)
  }
  log(`${dry ? '（確かめだけ。書きこんでいません）' : ''}本文に入れました: 授業 ${count.lessons} 件・差しかえ ${count.edits} か所（入れられなかった差しかえ ${count.skipped}）。指紋を新しくした用語集 ${count.annot} 件・記述論述 ${count.essay} 件／入れる差しかえが無い授業 ${count.nothing} 件／案のあとで本文が変わっていた授業 ${count.stale} 件／案がまだ無い授業 ${count.none} 件／もう入れてあった授業 ${count.already} 件${dry ? '' : `／直す前の本文は ${backup}`}`)
}

const GROUPS = [
  ['deep', '小学校（学び直し版）'],
  ['es', '小学校'],
  ['jhs', '中学校'],
  ['hs', '高校'],
  ['hsp', '高校（専門）'],
]
const groupOf = (r) => (r.meta.school === 'es' && r.meta.deep ? 'deep' : r.meta.school)
const flat = (text) => String(text ?? '').replace(/\s*\n\s*/g, ' ').trim()
const nameOf = (f) => (f.kind === 'term' ? `用語「${f.target}」` : f.target)
const percent = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—')

/** まとめを、文章のファイル（Markdown）に書き出す */
export function reportBodies({ recordDir, readJson, reportDir, backup, schools = [] }) {
  mkdirSync(reportDir, { recursive: true })
  // --schools でえらんだ学校の記録だけにする（えらばなければ、ぜんぶ）
  const records = readdirSync(recordDir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(recordDir, f), null)).filter(Boolean).filter((r) => !schools.length || schools.includes(r.meta.school))
  records.sort((a, b) => GROUPS.findIndex(([id]) => id === groupOf(a)) - GROUPS.findIndex(([id]) => id === groupOf(b)) || a.key.localeCompare(b.key, 'ja', { numeric: true }))
  const all = tallyBodies(records)
  const appliedOf = (list) => ({ lessons: list.filter((r) => r.appliedAt).length, edits: list.reduce((n, r) => n + r.edits.filter((e) => e.applied).length, 0) })
  const done = appliedOf(records)
  const first = records[0]
  const md = ['# 授業の本文の直し（まとめ）', '']
  md.push(`- 書き出した日: ${new Date().toLocaleString('ja-JP')}`)
  md.push(`- 対象: 用語集・記述論述の直しで「授業の本文にも同じ誤りがある」と印の付いた指摘のある授業 ${all.lessons} 件（指摘 ${all.findings} 件）`)
  md.push(`- 直した役: Claude（${first?.model ?? ''}・思考量 ${first?.effort ?? ''}）。指摘ごとに本文を読み、誤りの文があるときだけ、その文を差しかえました（全文は書き直していません）。`)
  md.push('- 確かめた役: Codex。差しかえを 1 件ずつ確かめ、「正しい」としたものだけを入れました。通らなかったものは、理由を添えて 1 回だけ直し直しています。')
  md.push(`- 教材に入れたもの: 授業 ${done.lessons} 件・差しかえ ${done.edits} か所。直す前の本文は ${backup} に残してあります。`)
  md.push(`- かかった量（Claude）: API 換算 約 ${all.cost.toFixed(1)} ドル（1 授業あたり ${(all.cost / Math.max(1, all.lessons)).toFixed(3)} ドル）`, '')
  md.push('## 指摘の判定と、差しかえ', '')
  md.push('| 学校 | 授業 | 指摘 | 誤りがある | 直さない | 本文には無い | 差しかえの案 | Codex 正しい | 直した文に誤り | 直す必要なし | 機械の確かめで保留 | 入れた授業 | 入れた差しかえ |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const [id, label] of GROUPS) {
    const list = records.filter((r) => groupOf(r) === id)
    const t = tallyBodies(list)
    const d = appliedOf(list)
    if (t.lessons) md.push(`| ${label} | ${t.lessons} | ${t.findings} | ${t.誤りがある} | ${t.直さない} | ${t.本文には無い} | ${t.edits} | ${t.pass} | ${t.wrong} | ${t.unneeded} | ${t.held} | ${d.lessons} | ${d.edits} |`)
  }
  md.push(`| 合計 | ${all.lessons} | ${all.findings} | ${all.誤りがある} | ${all.直さない} | ${all.本文には無い} | ${all.edits} | ${all.pass} | ${all.wrong} | ${all.unneeded} | ${all.held} | ${done.lessons} | ${done.edits} |`, '')
  md.push(`- 指摘のうち、本文に誤りがあると判定したもの: ${percent(all.誤りがある, all.findings)}`)
  md.push(`- 差しかえの案のうち、Codex が「正しい」としたもの: ${percent(all.pass, all.checked)}`)
  md.push(`- 図・挿絵・動く図解などのブロックの中の誤り（直していません）: ${all.blocks} 件`, '')
  md.push('## 教科ごと', '')
  md.push('| 学校 | 教科 | 授業 | 指摘 | 誤りがある | 入れた授業 | 入れた差しかえ | 入れなかった差しかえ |', '|---|---|---:|---:|---:|---:|---:|---:|')
  const subjects = new Map()
  for (const r of records) {
    const id = `${groupOf(r)}|${r.meta.subject}`
    subjects.set(id, [...(subjects.get(id) ?? []), r])
  }
  for (const [id, list] of subjects) {
    const t = tallyBodies(list)
    const d = appliedOf(list)
    md.push(`| ${GROUPS.find(([g]) => g === id.split('|')[0])[1]} | ${id.split('|')[1]} | ${t.lessons} | ${t.findings} | ${t.誤りがある} | ${d.lessons} | ${d.edits} | ${t.edits - d.edits} |`)
  }
  md.push('', '## ほかのファイル', '')
  md.push('- 本文の差しかえの一覧.md … 入れた差しかえ（直す前 → 直した後）と、もとの指摘')
  md.push('- 本文で直さなかったもの.md … Codex が通さなかった差しかえ、機械の確かめで保留にしたもの、図などのブロックの中の誤り、「直さない」と判定した指摘')
  md.push('- 英語版: 本文を直した授業は、アプリで「日本語の本文が新しくなっています」の印が付きます（訳は、前のままです）。')
  writeFileSync(join(reportDir, '本文の直しのまとめ.md'), `${md.join('\n')}\n`, 'utf8')

  /** 科目 → 授業 の見出しを付けながら、行を並べる */
  const listing = (title, lead, rowsOf) => {
    const out = [`# ${title}`, '', lead, '']
    let course = ''
    let count = 0
    for (const r of records) {
      const rows = rowsOf(r)
      if (!rows.length) continue
      if (r.meta.course !== course) {
        course = r.meta.course
        out.push('', `## ${course}`)
      }
      out.push('', `### ${r.meta.lesson}${r.meta.deep ? '（学び直し版）' : ''}（${r.key}）`, ...rows)
      count += rows.length
    }
    out[2] = `${lead}（${count} 件）`
    return `${out.join('\n')}\n`
  }
  const about = (r, e) => e.ids.map((id) => r.findings.find((f) => f.id === id)).filter(Boolean).map((f) => `${nameOf(f)}・${f.part}: ${flat(f.what)}`).join(' ／ ')
  const editRow = (r, e, extra = '') => `- **${e.kind ?? '本文'}・${e.line} 行目**\n  - 直す前: ${e.old}\n  - 直した後: ${e.new}\n  - もとの指摘: ${about(r, e)}${extra}`
  writeFileSync(join(reportDir, '本文の差しかえの一覧.md'), listing('本文の差しかえの一覧', '教材に入れた差しかえです', (r) => r.edits.filter((e) => e.applied).map((e) => editRow(r, e))), 'utf8')

  const kept = ['# 本文で直さなかったもの', '']
  const section = (title, lead, rowsOf) => {
    const text = listing(title, lead, rowsOf)
    // 見出しを 1 段ずつ下げる（授業 → 科目 → 題 の順に。逆の順だと、同じ段になってしまう）
    kept.push(text.replace(/\n### /g, '\n#### ').replace(/\n## /g, '\n### ').replace(/^# /, '## '), '')
  }
  section('Codex が「直した文に誤りがある」とした差しかえ', '直し直しても通らなかったものです。本文は、直す前のままです', (r) => r.edits.filter((e) => e.status === 'ok' && e.check?.verdict === 'wrong').map((e) => editRow(r, e, `\n  - Codex の理由: ${flat(e.check.reason)}`)))
  section('Codex が「直す必要なし」とした差しかえ', '直す前の文で正しい、と判定されたものです。本文は、直す前のままです', (r) => r.edits.filter((e) => e.status === 'ok' && e.check?.verdict === 'unneeded').map((e) => editRow(r, e, `\n  - Codex の理由: ${flat(e.check.reason)}`)))
  section('機械の確かめで保留にした差しかえ', '形の確かめに通らなかったものです。本文は、直す前のままです', (r) => r.edits.filter((e) => e.status === 'held').map((e) => editRow(r, e, `\n  - 通らなかった点: ${e.problems.join('／')}`)))
  section('入れるときに、場所が定まらなかった差しかえ', '本文は、直す前のままです', (r) => r.edits.filter((e) => e.skipped).map((e) => editRow(r, e, `\n  - ${e.skipped}`)))
  section('図・挿絵・動く図解などのブロックの中の誤り', 'ブロックの中は、この道具では直しません', (r) => r.blocks.map((b) => `- ${nameOf(r.findings.find((f) => f.id === b.id) ?? { target: '' })}: ${b.note}`))
  section('「誤りがある」としたのに、差しかえが無い指摘', '直す役が差しかえを返さなかったものです', (r) => r.findings.filter((f) => r.verdicts[f.id]?.verdict === '誤りがある' && !r.edits.some((e) => e.ids.includes(f.id)) && !r.blocks.some((b) => b.id === f.id)).map((f) => `- **${nameOf(f)}・${f.part}**: ${flat(f.what)}\n  - 判定: ${r.verdicts[f.id].reason}`))
  section('「直さない」と判定した指摘', '本文の文は、その学年の簡略化、またはその場面に限った言い方として正しい、と判定したものです', (r) => r.findings.filter((f) => r.verdicts[f.id]?.verdict === '直さない').map((f) => `- **${nameOf(f)}・${f.part}**: ${flat(f.what)}\n  - 判定: ${r.verdicts[f.id].reason}`))
  section('「本文には無い」と判定した指摘', '用語集・問題だけの話で、本文には同じ誤りの文が無かったものです', (r) => r.findings.filter((f) => r.verdicts[f.id]?.verdict === '本文には無い').map((f) => `- **${nameOf(f)}・${f.part}**: ${flat(f.what)}\n  - 判定: ${r.verdicts[f.id].reason}`))
  writeFileSync(join(reportDir, '本文で直さなかったもの.md'), `${kept.join('\n')}\n`, 'utf8')
  console.log(`書き出しました: ${reportDir}（本文の直しのまとめ.md・本文の差しかえの一覧.md・本文で直さなかったもの.md）`)
  console.log(`授業 ${all.lessons} 件・指摘 ${all.findings} 件: 誤りがある ${all.誤りがある}・直さない ${all.直さない}・本文には無い ${all.本文には無い} ／ 差しかえ ${all.edits}（Codex 正しい ${all.pass}・誤り ${all.wrong}・必要なし ${all.unneeded}・保留 ${all.held}）／ 入れた授業 ${done.lessons} 件・差しかえ ${done.edits} か所`)
}
