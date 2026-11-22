// 授業の掘り下げ（tools/deepen-lessons.mjs）の進み具合を、ブラウザで見る。
//
//   node --no-warnings tools/deepen-view.mjs [--port 5281] [--no-open]
//   （ひとつ上のフォルダの「掘り下げの進み具合を見る.cmd」を開いても同じ）
//
// - この PC の中だけで見られるページ（http://127.0.0.1:5281/）を出す。15 秒ごとに、自動で新しくなる。
// - 掘り下げの道具が書いている記録（<データ置き場>/deepen/ の state.json・progress.json・metrics.jsonl・run.log）を読む。
//   掘り下げの道具が動いていなくても、最後の記録を見られる。
// - 書くのは、進め方の調整（<データ置き場>/deepen/control.json。同時に進める数と、Codex を休む割合）だけ。
//   ページの下の欄で変えると、動いている道具が 10 秒ほどで読みとる（道具が止まっていれば、次に動かしたときから使われる）。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : fallback
}
const PORT = Number(opt('port', 5281))
const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const outDir = join(dataDir, 'deepen')
const url = `http://127.0.0.1:${PORT}/`
const open = () => !args.includes('--no-open') && spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

// ───────── 進め方の調整 ─────────

const controlFile = join(outDir, 'control.json')
const CONTROL = { concurrency: [1, 48], reviewConcurrency: [1, 24], codexWeek: [10, 100] }
const readControl = () => ({ concurrency: 6, reviewConcurrency: 4, codexWeek: 90, stop: false, ...readJson(controlFile, {}) })
/** ページから送られた数を確かめて、書く。おかしな値があれば、何も書かずに、わけを返す */
function writeControl(input) {
  const next = readControl()
  for (const [name, [min, max]] of Object.entries(CONTROL)) {
    if (input?.[name] == null || input[name] === '') continue
    const value = Number(input[name])
    if (!Number.isInteger(value) || value < min || value > max) return `${min}〜${max} の整数を入れてください`
    next[name] = value
  }
  writeFileSync(`${controlFile}.tmp`, JSON.stringify(next, null, 1), 'utf8')
  renameSync(`${controlFile}.tmp`, controlFile)
  return ''
}

// ───────── 科目と授業の名前 ─────────

const catalog = readJson(join(root, 'resources', 'content', 'catalog.json'), { courses: [] })
const SCHOOL = { es: '小学', jhs: '中学', hs: '高校', hsp: '高校（専門）' }
const courseTitle = (c) => (/^\d(・\d)? 年$/.test(c.label) ? `${SCHOOL[c.school]} ${c.label} ${c.subjectLabel}` : c.school === 'hs' ? `高校 ${c.label}` : c.label === c.subjectLabel ? `${SCHOOL[c.school]} ${c.label}` : `${SCHOOL[c.school]} ${c.subjectLabel}（${c.label}）`)
/** 学び直し版（保存名の終わりが「.deep」）は、小学校とは別のまとまりで数える */
const isDeep = (key) => key.endsWith('.deep')
const baseOf = (key) => key.replace(/\.deep$/, '')
const courseOf = (key) => catalog.courses.find((c) => c.id === baseOf(key).replace(/-\d+-\d+$/, ''))
const curricula = new Map()
function lessonTitle(key) {
  const course = courseOf(key)
  if (!course) return ''
  if (!curricula.has(course.id)) {
    const own = join(dataDir, 'curricula', `${course.id}.json`)
    curricula.set(course.id, readJson(existsSync(own) ? own : join(root, 'resources', 'content', course.id, 'curriculum.json'), null))
  }
  const [u, l] = baseOf(key).match(/-(\d+)-(\d+)$/).slice(1).map(Number)
  return curricula.get(course.id)?.units[u - 1]?.lessons[l - 1]?.title ?? ''
}

/** 対象の授業（小学校・中学校・高校・高校（専門）の、本文がある授業）。授業のファイルは 1 万件をこえるので、1 分は覚えておく */
let targets = { at: 0, keys: [] }
function targetKeys() {
  if (Date.now() - targets.at > 60_000) {
    const dir = join(dataDir, 'lessons')
    const keys = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.md'))
          .map((f) => f.slice(0, -3))
          .filter((key) => /-\d+-\d+$/.test(baseOf(key)) && ['es', 'jhs', 'hs', 'hsp'].includes(courseOf(key)?.school))
          // 単元表に無い授業のファイル（古い授業。アプリには出ない）は、数えない（掘り下げの道具と同じ決まり）
          .filter((key) => lessonTitle(key) !== '')
      : []
    targets = { at: Date.now(), keys }
  }
  return targets.keys
}

// ───────── まとめる ─────────

const GROUPS = { applied: 'applied', passed: 'passed', evaluated: 'working', drafted: 'working', fix: 'working', held: 'held', failed: 'failed' }

function summary() {
  const state = readJson(join(outDir, 'state.json'), {})
  const progress = readJson(join(outDir, 'progress.json'), null)
  const keys = targetKeys()
  const blank = () => ({ total: 0, applied: 0, passed: 0, working: 0, held: 0, failed: 0, todo: 0 })
  const totals = blank()
  const byCourse = new Map()
  for (const key of keys) {
    const course = courseOf(key)
    const id = isDeep(key) ? `${course.id}.deep` : course.id
    if (!byCourse.has(id)) byCourse.set(id, { id, base: course.id, school: isDeep(key) ? 'deep' : course.school, title: `${courseTitle(course)}${isDeep(key) ? '（学び直し版）' : ''}`, ...blank() })
    const group = GROUPS[state[key]?.stage] ?? 'todo'
    for (const row of [totals, byCourse.get(id)]) {
      row.total += 1
      row[group] += 1
    }
  }
  const order = new Map(catalog.courses.map((c, i) => [c.id, (c.school === 'jhs' ? 0 : 10_000) + i]))
  const courses = [...byCourse.values()].sort((a, b) => order.get(a.base) - order.get(b.base))

  // 速さ: 直近 60 分に「書き直し」が終わった件数（記録の 1 行が、AI の呼び出し 1 回）
  const hourAgo = Date.now() - 60 * 60_000
  let drafted = 0
  let lastCall = 0
  const metricsFile = join(outDir, 'metrics.jsonl')
  if (existsSync(metricsFile)) {
    for (const line of readFileSync(metricsFile, 'utf8').split('\n').slice(-4000)) {
      if (!line) continue
      try {
        const row = JSON.parse(line)
        const at = Date.parse(row.at)
        lastCall = Math.max(lastCall, at)
        if (row.stage === 'expand' && at >= hourAgo) drafted += 1
      } catch {
        // 書きかけの行は、とばす
      }
    }
  }
  const entries = Object.entries(state)
  const done = entries.filter(([, s]) => s.stage === 'applied' || s.stage === 'passed')
  const ratios = done.map(([, s]) => s.ratio).filter((x) => typeof x === 'number')
  const logFile = join(outDir, 'run.log')
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-30) : []
  const lastWrite = Math.max(progress ? Date.parse(progress.at) : 0, existsSync(logFile) ? statSync(logFile).mtimeMs : 0, lastCall)
  return {
    now: Date.now(),
    lastWrite,
    // 3 分より新しい記録があれば、動いているとみなす（道具は、1 分ごとに進み具合を書く）
    running: Date.now() - lastWrite < 3 * 60_000,
    totals,
    courses,
    perHour: drafted,
    ratio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null,
    fixed: done.filter(([, s]) => s.fixes > 0).length,
    control: readControl(),
    codexStopAt: progress?.control?.codexStopAt ?? null,
    api: progress?.api ?? null,
    working: progress?.working ?? null,
    codex: progress?.codex ?? null,
    claude: progress?.claude ?? null,
    appOpen: progress?.appOpen ?? null,
    minutes: progress?.minutes ?? null,
    problems: entries.filter(([, s]) => s.stage === 'held' || s.stage === 'failed').map(([key, s]) => ({ key, course: courseOf(key) ? courseTitle(courseOf(key)) : '', title: lessonTitle(key), stage: s.stage, why: String(s.why ?? '').slice(0, 300) })).filter((p) => keys.includes(p.key)),
    recent: done.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, 15).map(([key, s]) => ({ key, course: courseOf(key) ? courseTitle(courseOf(key)) : '', title: lessonTitle(key), stage: s.stage, chars: s.chars, length: s.length, fixes: s.fixes ?? 0, at: s.at })),
    log,
  }
}

// ───────── ページ ─────────

const PAGE = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>掘り下げの進み具合</title>
<style>
  :root { --ink: #2c2a35; --sub: #6b6775; --line: #ddd6c8; --paper: #fbf8f1; --bg: #f3eee3; --done: #2e7d6b; --wait: #7fb9a8; --work: #e3a94a; --bad: #c0563f; --todo: #e3ddd0; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: "Yu Gothic UI", "Hiragino Sans", "Noto Sans JP", sans-serif; line-height: 1.6; }
  main { max-width: 980px; margin: 0 auto; padding: 20px 16px 60px; }
  h1 { font-size: 1.35rem; margin: 0 0 4px; }
  h2 { font-size: 1.05rem; margin: 28px 0 8px; }
  .sub { color: var(--sub); font-size: 0.86rem; }
  .card { background: var(--paper); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; margin-top: 12px; }
  .status { display: flex; gap: 10px; align-items: center; font-weight: 700; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--sub); flex: none; }
  .dot[data-s="run"] { background: var(--done); } .dot[data-s="rest"] { background: var(--work); } .dot[data-s="stop"] { background: var(--bad); }
  .bar { display: flex; height: 22px; border-radius: 11px; overflow: hidden; background: var(--todo); margin: 12px 0 8px; }
  .bar > span { display: block; height: 100%; }
  .applied { background: var(--done); } .passed { background: var(--wait); } .working { background: var(--work); } .held, .failed { background: var(--bad); }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 0.9rem; }
  .legend i { display: inline-block; width: 11px; height: 11px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
  .big { font-size: 1.9rem; font-weight: 700; } .big small { font-size: 1rem; font-weight: 400; color: var(--sub); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
  .grid .card { margin-top: 0; } .grid b { display: block; font-size: 1.25rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { color: var(--sub); font-weight: 400; } td.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  td .bar { height: 10px; margin: 0; min-width: 120px; }
  .scroll { overflow-x: auto; }
  pre { margin: 0; font-size: 0.8rem; white-space: pre-wrap; word-break: break-all; color: #48454f; font-family: Consolas, "MS Gothic", monospace; }
  details summary { cursor: pointer; font-weight: 700; padding: 4px 0; }
  .note { background: #fff6dc; border: 1px solid #ecd9a0; border-radius: 10px; padding: 8px 12px; margin-top: 10px; font-size: 0.92rem; }
  .bad { color: var(--bad); }
  form.control { display: flex; flex-wrap: wrap; gap: 10px 22px; align-items: end; }
  form.control label { display: flex; flex-direction: column; gap: 3px; font-size: 0.9rem; }
  form.control input { width: 7em; font: inherit; padding: 5px 8px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
  form.control button { font: inherit; font-weight: 700; padding: 6px 16px; border: 0; border-radius: 8px; background: var(--done); color: #fff; cursor: pointer; }
</style>
</head>
<body>
<main>
  <h1>授業の掘り下げの進み具合</h1>
  <p class="sub">中学校と高校の授業を、Codex が評価して書き直し、Claude が読み直してから、元の授業と置きかえています。このページは 15 秒ごとに新しくなります。<span id="stamp"></span></p>
  <div id="app"><div class="card">読みこんでいます…</div></div>
  <h2>進め方を変える</h2>
  <div class="card">
    <form class="control" id="control">
      <label>評価・掘り下げ（Codex）を同時に進める数<input type="number" name="concurrency" min="1" max="48" required></label>
      <label>読み直し（Claude）を同時に進める数<input type="number" name="reviewConcurrency" min="1" max="24" required></label>
      <label>Codex を休む、週の使用割合（%）<input type="number" name="codexWeek" min="10" max="100" required></label>
      <button>この数に変える</button>
    </form>
    <p class="sub" id="controlNote">変えた数は、10 秒ほどで道具に伝わります（進めている途中の授業は、そのまま終わらせます）。</p>
    <p class="sub">同時に進める数を増やすと、そのぶん速く進みます。Codex の使用量も、同じだけ速く進みます。読み直しは、評価・掘り下げの 3 分の 1 ほどの数で足ります。</p>
  </div>
</main>
<script>
const $ = (html) => { const t = document.createElement('template'); t.innerHTML = html; return t.content }
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const time = (ms) => new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const pct = (x) => (x == null ? '—' : Math.round(x * 100) + '%')
const bar = (r) => '<div class="bar">' + ['applied', 'passed', 'working', 'held', 'failed'].map((k) => r[k] ? '<span class="' + k + '" style="width:' + (r[k] / r.total * 100) + '%" title="' + r[k] + ' 件"></span>' : '').join('') + '</div>'
const LABEL = { applied: '置きかえ済み', passed: '置きかえ待ち', held: '保留', failed: '失敗' }
let openSchools = new Set(JSON.parse(sessionStorage.getItem('open') || '[]'))

function render(d) {
  const t = d.totals
  const left = t.todo + t.working
  const resting = d.codex?.paused || d.claude?.paused
  const s = !d.running ? 'stop' : resting ? 'rest' : 'run'
  const statusText = !d.running
    ? (left ? '止まっています（最後の記録: ' + time(d.lastWrite) + '）' : 'すべて終わりました')
    : resting ? '休んでいます（使用量の上限に近づいたため）' : '動いています'
  const hours = d.perHour > 0 ? left / d.perHour : null
  const eta = hours == null ? '—' : hours < 1 ? 'あと 1 時間以内' : hours < 48 ? 'あと約 ' + Math.round(hours) + ' 時間' : 'あと約 ' + Math.round(hours / 24) + ' 日'
  const notes = []
  if (d.running && d.appOpen && t.passed) notes.push('学びアイ（アプリ）が開いているので、' + t.passed + ' 件が置きかえを待っています。アプリを閉じると、1 分ほどで置きかわります。')
  if (d.codex?.paused) notes.push('Codex を休ませています（' + esc(d.codex.why) + '）。' + (d.codex.resetsAt ? time(Date.parse(d.codex.resetsAt)) + ' ごろに回復して、続きから進みます。' : ''))
  if (d.claude?.paused) notes.push('Claude を休ませています（' + esc(d.claude.pauseWhy) + '）。' + (d.claude.pauseUntil ? time(Date.parse(d.claude.pauseUntil)) + ' ごろに、もう一度確かめます。' : ''))
  if (!d.running && left) notes.push('続きから進めるには、Claude に「掘り下げを再開して」と頼むか、app フォルダで <code>node --no-warnings tools/deepen-lessons.mjs --schools es,jhs,hs,hsp</code> を実行します。')
  const schools = [['es', '小学校'], ['deep', '小学校（学び直し版）'], ['jhs', '中学校'], ['hs', '高校'], ['hsp', '高校（専門）']].map(([id, name]) => {
    const rows = d.courses.filter((c) => c.school === id)
    const sum = rows.reduce((a, c) => { for (const k of Object.keys(a)) a[k] += c[k]; return a }, { total: 0, applied: 0, passed: 0, working: 0, held: 0, failed: 0, todo: 0 })
    return '<details data-school="' + id + '"' + (openSchools.has(id) ? ' open' : '') + '><summary>' + name + '　' + (sum.applied + sum.passed) + ' / ' + sum.total + ' 件（' + rows.length + ' 科目）</summary><div class="scroll"><table><tr><th>科目</th><th>進み具合</th><th class="n">終わった</th><th class="n">作業中</th><th class="n">保留・失敗</th><th class="n">まだ</th></tr>' +
      rows.map((c) => '<tr><td>' + esc(c.title) + '</td><td>' + bar(c) + '</td><td class="n">' + (c.applied + c.passed) + ' / ' + c.total + '</td><td class="n">' + (c.working || '') + '</td><td class="n' + (c.held + c.failed ? ' bad' : '') + '">' + (c.held + c.failed || '') + '</td><td class="n">' + (c.todo || '') + '</td></tr>').join('') + '</table></div></details>'
  }).join('')
  document.getElementById('app').replaceChildren($(
    '<div class="card"><div class="status"><span class="dot" data-s="' + s + '"></span>' + statusText + '</div>' +
    '<div class="big">' + (t.applied + t.passed) + ' <small>/ ' + t.total + ' 件が、読み直しを通りました（' + ((t.applied + t.passed) / Math.max(1, t.total) * 100).toFixed(1) + '%）</small></div>' + bar(t) +
    '<div class="legend"><span><i class="applied"></i>置きかえ済み ' + t.applied + '</span><span><i class="passed"></i>置きかえ待ち ' + t.passed + '</span><span><i class="working"></i>作業中 ' + t.working + '</span><span><i class="held"></i>保留・失敗 ' + (t.held + t.failed) + '</span><span><i style="background:var(--todo)"></i>まだ ' + t.todo + '</span></div>' +
    notes.map((n) => '<div class="note">' + n + '</div>').join('') + '</div>' +
    '<div class="grid" style="margin-top:12px">' +
    '<div class="card"><span class="sub">同時に進めている数</span><b>' + (d.running && d.working ? 'Codex ' + d.working.codex + '・Claude ' + d.working.review : '—') + '</b><span class="sub">決めた数: Codex ' + d.control.concurrency + '・Claude ' + d.control.reviewConcurrency + '</span></div>' +
    '<div class="card"><span class="sub">速さ（直近 1 時間）</span><b>' + d.perHour + ' 件 / 時</b><span class="sub">' + (d.running && !resting ? eta + '（休みをのぞく）' : '') + '</span></div>' +
    '<div class="card"><span class="sub">Codex の使用量（週）</span><b>' + (d.codex?.percent == null ? '—' : d.codex.percent + '%') + '</b><span class="sub">' + (d.codexStopAt ?? d.control.codexWeek) + '% で休みます（' + d.control.codexWeek + '% をこえないよう、手前で止めます）' + (d.codex?.resetsAt ? '。回復: ' + time(Date.parse(d.codex.resetsAt)) : '') + (d.api?.budget ? '。上限に届いたら API で続けます（' + d.api.spent + ' / ' + d.api.budget + ' ドル' + (d.api.active ? '。いま API で動いています' : '') + (d.api.blocked ? '。API は使えませんでした' : '') + '）' : '') + '</span></div>' +
    '<div class="card"><span class="sub">Claude の使用量</span><b>5 時間 ' + pct(d.claude?.five) + '・週 ' + pct(d.claude?.week) + '</b><span class="sub">85%・86% で休みます</span></div>' +
    '<div class="card"><span class="sub">書き直したあとの分量</span><b>' + (d.ratio ? '元の約 ' + d.ratio.toFixed(1) + ' 倍' : '—') + '</b><span class="sub">読み直しで直しが入った授業: ' + d.fixed + ' 件</span></div>' +
    '</div>' +
    '<h2>科目ごと</h2><div class="card">' + schools + '</div>' +
    '<h2>置きかえなかった授業（保留・失敗）</h2><div class="card">' + (d.problems.length ? '<div class="scroll"><table><tr><th>授業</th><th>状態</th><th>わけ</th></tr>' + d.problems.map((p) => '<tr><td>' + esc(p.course) + '<br><span class="sub">' + esc(p.key.replace(/\\.deep$/, '').match(/-(\\d+-\\d+)$/)[1] + ' ' + p.title) + '</span></td><td class="bad">' + LABEL[p.stage] + '</td><td>' + esc(p.why) + '</td></tr>').join('') + '</table></div><p class="sub">保留は、読み直しで重い問題が残ったもの。元の授業のまま残しています。</p>' : 'いまのところ、ありません。') + '</div>' +
    '<h2>さいきん通った授業</h2><div class="card"><div class="scroll"><table><tr><th>授業</th><th>状態</th><th class="n">分量（字）</th><th class="n">直し</th><th class="n">時刻</th></tr>' + d.recent.map((r) => '<tr><td>' + esc(r.course) + '<br><span class="sub">' + esc(r.key.replace(/\\.deep$/, '').match(/-(\\d+-\\d+)$/)[1] + ' ' + r.title) + '</span></td><td>' + LABEL[r.stage] + '</td><td class="n">' + (r.chars ?? '?') + ' → ' + (r.length ?? '?') + '</td><td class="n">' + (r.fixes ? r.fixes + ' 回' : '') + '</td><td class="n">' + (r.at ? time(r.at) : '') + '</td></tr>').join('') + '</table></div></div>' +
    '<h2>道具の記録（新しいものが下）</h2><div class="card"><pre>' + esc(d.log.join('\\n')) + '</pre></div>' +
    '<p class="sub">元の授業の控え: 学びアイ\\\\保管\\\\掘り下げ前の授業\\\\lessons</p>'
  ))
  document.querySelectorAll('details[data-school]').forEach((el) => el.addEventListener('toggle', () => { el.open ? openSchools.add(el.dataset.school) : openSchools.delete(el.dataset.school); sessionStorage.setItem('open', JSON.stringify([...openSchools])) }))
  document.getElementById('stamp').textContent = '（' + new Date(d.now).toLocaleTimeString('ja-JP') + ' の時点）'
  // 欄にさわっていないあいだだけ、いまの数を入れ直す（打っている途中の数を、消さない）
  const form = document.getElementById('control')
  if (!form.contains(document.activeElement) && !form.dataset.dirty) for (const name of ['concurrency', 'reviewConcurrency', 'codexWeek']) form.elements[name].value = d.control[name]
}
document.getElementById('control').addEventListener('input', (event) => { event.currentTarget.dataset.dirty = '1' })
document.getElementById('control').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const note = document.getElementById('controlNote')
  const body = Object.fromEntries(['concurrency', 'reviewConcurrency', 'codexWeek'].map((name) => [name, Number(form.elements[name].value)]))
  try {
    const res = await fetch('control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const out = await res.json()
    note.textContent = out.error ? '変えられませんでした: ' + out.error : '変えました（' + new Date().toLocaleTimeString('ja-JP') + '）。10 秒ほどで道具に伝わります。'
    if (!out.error) delete form.dataset.dirty
    load()
  } catch (error) {
    note.textContent = '変えられませんでした。この窓のもとの黒い画面が閉じていないか、確かめてください。'
  }
})
async function load() {
  try {
    render(await (await fetch('data', { cache: 'no-store' })).json())
  } catch (error) {
    document.getElementById('stamp').textContent = '（読みこめませんでした。この窓のもとの黒い画面が閉じていないか、確かめてください）'
  }
}
load()
setInterval(load, 15000)
</script>
</body>
</html>`

const server = createServer((req, res) => {
  const path = new URL(req.url, url).pathname
  try {
    if (path === '/data') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(JSON.stringify(summary()))
    }
    if (path === '/control' && req.method === 'POST') {
      // このページからの書きこみだけを受けつける（ほかのサイトのページからは、変えられない）
      if (![`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`].includes(req.headers.origin ?? '')) return res.writeHead(403).end()
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 2000) req.destroy()
      })
      req.on('end', () => {
        let error = '送られた内容を読めませんでした'
        try {
          error = writeControl(JSON.parse(body))
        } catch {}
        res.writeHead(error ? 400 : 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ error }))
      })
      return
    }
    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(PAGE)
    }
    res.writeHead(404).end()
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(error?.message ?? error))
  }
})
server.on('error', (error) => {
  // すでに開いているとき（同じ番号を使っている）は、ブラウザで開くだけにする
  if (error.code === 'EADDRINUSE') {
    open()
    console.log(`すでに動いています。ブラウザで開きます: ${url}`)
    process.exit(0)
  }
  throw error
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`掘り下げの進み具合: ${url}`)
  console.log('この窓を閉じると、ページの表示が止まります（掘り下げの作業そのものは、止まりません）。')
  open()
})
