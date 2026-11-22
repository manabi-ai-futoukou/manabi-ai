// 記述・論述の問題と解答例、用語集（用語・読み・説明）を、codex に検査させる。検査だけで、何も書きかえない。
//
//   node --no-warnings tools/inspect-extras.mjs [--schools es,jhs,hs] [--courses 科目,…] [--only 保存名,…] [--limit まとまりの数]
//        [--batch 5] [--concurrency 24] [--model gpt-6.2-sol] [--effort high] [--codex-week 96] [--redo] [--count]
//   node --no-warnings tools/inspect-extras.mjs --report [--report-dir フォルダ]
//
// - 授業 5 件ずつを 1 つのまとまりにして、その授業の「用語（annot/<保存名>.json の terms）」と
//   「記述・論述の問題と解答例（essay/<保存名>.json）」を codex に読ませ、誤り・不備だけを報告させる。
//   授業の本文は、見出しとねらいだけを添える（本文との照らし合わせは、作るときに済んでいる）。
// - 指摘は「本物の誤り（error）」と「軽いもの（minor）」に分けさせる。学校の段階でふつうの簡略化は、誤りにしない。
// - 結果は <データ置き場>/inspect/batches/<まとまり>.json に置く。もう検査したまとまりは、とばす（中身が変わっていれば、やり直す）。
// - codex の週の使用割合が --codex-week（既定 96%）に達したら、新しいまとまりを始めずに終わる。API（従量の料金）には切りかえない。
// - --report: たまった結果を集めて、まとめ・誤りの一覧・すべての指摘（JSON）を書き出す（既定は アプリの 1 つ上のフォルダの「検査の結果」）。
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { countChars, writingTargets } from '../src/shared/essay.ts'

const args = process.argv.slice(2)
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback)
const has = (name) => args.includes(`--${name}`)
const list = (name) => opt(name, '').split(',').filter(Boolean)
const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const lessonsDir = join(dataDir, 'lessons')
const outDir = join(dataDir, 'inspect')
const batchDir = join(outDir, 'batches')
const workDir = join(dataDir, 'ai-workdir')
for (const dir of [batchDir, workDir]) mkdirSync(dir, { recursive: true })
const model = opt('model', 'gpt-6.2-sol')
const effort = opt('effort', 'high')
const BATCH = Number(opt('batch', 5))
const CODEX_WEEK = Number(opt('codex-week', 96))
const PROBE_EVERY = Number(opt('probe-every', 40))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12)
const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (file, value, pretty = false) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, pretty ? 1 : 0), 'utf8')
  renameSync(`${file}.tmp`, file)
}
const read = (file) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
const logFile = join(outDir, 'run.log')
const log = (text) => {
  const line = `${new Date().toLocaleTimeString('ja-JP', { hour12: false })} ${text}`
  console.log(line)
  if (!has('report') && !has('count')) appendFileSync(logFile, `${line}\n`, 'utf8')
}

// ───────── 検査するもの ─────────

const catalog = JSON.parse(readFileSync(join(root, 'resources', 'content', 'catalog.json'), 'utf8'))
const SCHOOL_SHORT = { es: '小学', jhs: '中学', hs: '高校', hsp: '高校（専門）', univ: '大学', grad: '大学院' }
const SCHOOL_LONG = { es: '小学校', jhs: '中学校', hs: '高校', hsp: '高校（専門）' }
function courseTitle(c) {
  if (/^\d(・\d)? 年$/.test(c.label)) return `${SCHOOL_SHORT[c.school]} ${c.label} ${c.subjectLabel}`
  if (c.school === 'hs') return `高校 ${c.label}`
  if (c.school === 'hsp') return `高校 ${c.subjectLabel}（${c.label}）`
  return c.label === c.subjectLabel ? `${SCHOOL_SHORT[c.school]} ${c.label}` : `${SCHOOL_SHORT[c.school]} ${c.subjectLabel}（${c.label}）`
}
const schools = list('schools').length ? list('schools') : ['es', 'jhs', 'hs']
const onlyCourses = list('courses')
const onlyKeys = list('only')
const generated = new Set(readdirSync(lessonsDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)))

/** 授業の本文から、見出しと「ねらい」だけを取り出す（掛け合い・図などのブロックは、とばす） */
function digest(body) {
  const lines = body.replace(/```[\s\S]*?```/g, '').split('\n')
  const heads = lines.filter((l) => /^#{1,3} /.test(l)).map((l) => l.replace(/^#+ /, (m) => '  '.repeat(m.length - 2)))
  const start = lines.findIndex((l) => /^## .*ねらい/.test(l))
  let aims = ''
  if (start >= 0) {
    const end = lines.findIndex((l, i) => i > start && /^## /.test(l))
    aims = lines.slice(start + 1, end < 0 ? start + 12 : end).join('\n').trim().slice(0, 500)
  }
  return { heads: heads.join('\n').slice(0, 900), aims }
}

const targets = []
for (const c of catalog.courses) {
  if (onlyCourses.length ? !onlyCourses.includes(c.id) : !schools.includes(c.school)) continue
  const shipped = join(root, 'resources', 'content', c.id, 'curriculum.json')
  const curriculum = existsSync(shipped) ? readJson(shipped, null) : readJson(join(dataDir, 'curricula', `${c.id}.json`), null)
  if (!curriculum?.units?.length) continue
  const grade = c.school === 'es' ? Number(c.label.match(/(\d) 年$/)?.[1] ?? 6) : null
  curriculum.units.forEach((unit, u) =>
    unit.lessons.forEach((lesson, l) => {
      const key = `${c.id}-${u + 1}-${l + 1}`
      const wanted = (k) => !onlyKeys.length || onlyKeys.includes(k)
      if (!wanted(key) && !wanted(`${key}.deep`)) return
      const authored = join(root, 'resources', 'content', c.id, `${key}.md`)
      const file = existsSync(authored) ? authored : generated.has(key) ? join(lessonsDir, `${key}.md`) : null
      if (!file) return
      const terms = readJson(join(dataDir, 'annot', `${key}.json`), null)?.terms ?? []
      const essay = readJson(join(dataDir, 'essay', `${key}.json`), null)
      if (wanted(key) && (terms.length || essay)) targets.push({ key, file, course: c, grade, unitTitle: unit.title, number: `${u + 1}-${l + 1}`, title: lesson.title, terms, essay })
      // 小学校の「学び直し版」（中学生より上の人が、小学校の内容を学び直すための本文）。用語だけがある
      const deepTerms = readJson(join(dataDir, 'annot', `${key}.deep.json`), null)?.terms ?? []
      const deepFile = join(lessonsDir, `${key}.deep.md`)
      if (wanted(`${key}.deep`) && deepTerms.length && existsSync(deepFile)) targets.push({ key: `${key}.deep`, file: deepFile, course: c, grade, unitTitle: unit.title, number: `${u + 1}-${l + 1}`, title: lesson.title, terms: deepTerms, essay: null, deep: true })
    }),
  )
}

const flat = (text) => String(text ?? '').replace(/\s*\n\s*/g, ' ').trim()
const essayText = (answer) => (typeof answer === 'string' ? answer : [answer?.intro, answer?.body, answer?.conclusion].filter(Boolean).join(''))
function lessonBlock(t, index) {
  const { heads, aims } = digest(read(t.file))
  const goal = writingTargets(t.course.school, t.grade)
  const out = [`## 授業 ${index + 1}（key: ${t.key}）`, `- 科目: ${courseTitle(t.course)}／単元「${t.unitTitle}」／${t.number}「${t.title}」`]
  if (t.deep) out.push('- この授業は「学び直し版」です（中学生より上の人が、小学校の内容を学び直すための本文。漢字と言葉づかいは、中学生より上に合わせてあります）')
  if (t.essay) out.push(`- 字数の目安: 記述 ${goal.short[0]}〜${goal.short[2]} 字（めやす ${goal.short[1]} 字）、論述 ${goal.long[0]}〜${goal.long[1]} 字`)
  out.push('', '### 授業の見出し', heads || '（なし）')
  if (aims) out.push('', '### 授業のねらい', aims)
  if (t.terms.length) {
    out.push('', `### 用語（${t.terms.length} 個）`)
    t.terms.forEach((term, i) => {
      out.push(`${i + 1}. 用語: ${flat(term.term)}／読み: ${flat(term.reading)}${term.aliases?.length ? `／別名: ${term.aliases.map(flat).join('、')}` : ''}`)
      out.push(`   - 簡単な説明: ${flat(term.short)}`)
      if (term.detail) out.push(`   - くわしい説明: ${flat(term.detail)}`)
    })
  }
  if (t.essay) {
    ;(t.essay.short ?? []).forEach((q, i) => {
      out.push('', `### 記述${i + 1}`, `- 問い: ${flat(q.question)}`, `- 解答例（${countChars(q.answer)} 字）: ${flat(q.answer)}`, `- 採点の要点: ${(q.points ?? []).map((p) => `「${flat(p)}」`).join(' ')}`)
    })
    ;(t.essay.long ?? []).forEach((q, i) => {
      out.push('', `### 論述${i + 1}`, `- 問い: ${flat(q.question)}`, `- 解答例（${countChars(essayText(q.answer))} 字）:`, `  【序論】${flat(q.answer?.intro)}`, `  【本論】${flat(q.answer?.body)}`, `  【結論】${flat(q.answer?.conclusion)}`, `- 採点の要点: ${(q.points ?? []).map((p) => `「${flat(p)}」`).join(' ')}`)
    })
  }
  return out.join('\n')
}

const INSTRUCTIONS = `あなたは、日本の小学校・中学校・高校の教材を点検する、経験のある校閲者です。
下に、学習アプリの授業ごとの「用語（用語集にのる言葉・読み・説明）」と「記述・論述の問題と解答例・採点の要点」を載せます。
これらは AI が作ったもので、人の確認を経ていません。誤りと不備を見つけて、報告してください。**検査だけ**です。直した全文は書かないでください。

## 見るところ
用語:
- 読み（ひらがな）が正しいか。英語の言葉の読みは、五十音順に並べるためのかな書きなので、明らかにおかしいときだけ指摘します。
- 簡単な説明・くわしい説明の内容が正しいか（定義・年代・人名・数値・式・法則・用法）。
- 別名が、本当に同じものを指すか。
- その学年の生徒に通じる説明か（その段階では習わない言葉だけで説明している、など）。
記述・論述:
- 解答例・採点の要点に、事実の誤りが無いか（年代・人名・用語・数値・式・法則・因果関係、英語や古文の例文の文法）。
- 問いと解答例がかみ合っているか（問いに答えているか、問いの条件を守っているか）。
- 採点の要点が、解答例と食いちがっていないか。
- 問いに不備が無いか（何を答えればよいか定まらない、前提が誤っている、その学年の範囲を大きくこえる）。
- 解答例の字数が、字数の目安から大きく外れていないか（外れは軽いもの）。

## 分け方（大切）
- error（本物の誤り）: 事実・定義・読み・文法の誤り、問いと解答例のかみ合わなさ、答えが定まらない問い、学年の範囲を大きくこえる内容。生徒がまちがって覚えてしまうもの。
- minor（軽いもの）: 言い回し、説明の足りなさ、字数のずれ、要点の重なりなど。
- **学校の段階と学習指導要領を考えます。** その学年でふつうに教える簡略化（例: 小学校で「植物は日光で養分をつくる」）は、誤りにも軽いものにもしません。「大学ではこう言う」「厳密にはこうだ」というだけの指摘は、しないでください。
- 論述は、答えが 1 つではありません。解答例の立場そのものは問いません。根拠にした事実が誤っているときだけ error にします。
- 授業の本文は載せていません（見出しとねらいだけ）。「本文に書いてあるか分からない」という理由では、指摘しないでください。
- 自信がない指摘は sure を false にします。確かめる必要がある事実だけ、ウェブ検索で確かめてかまいません（調べたサイトの URL は書かなくてよい）。
- 問題が無い用語・問題は、何も書きません。指摘が無い授業も、findings を空の配列にして、必ず lessons に入れてください。

## 返事の形（JSON）
lessons: 授業ごとに { key, terms: [...], essay: [...] }
- terms の 1 件: { term（用語をそのまま）, part（「読み」「簡単な説明」「くわしい説明」「別名」「用語」のどれか）, severity（error / minor）, what（何が問題か。1〜2 文）, fix（どう直すか。1〜2 文。読みの誤りなら正しい読み）, sure }
- essay の 1 件: { item（「記述1」「記述2」「論述1」など、見出しのとおり）, part（「問い」「解答例」「要点」のどれか）, severity, what, fix, sure }
`

const finding = (first, firstValues, parts) => ({
  type: 'object',
  properties: {
    [first]: { type: 'string', ...(firstValues ? { enum: firstValues } : {}) },
    part: { type: 'string', enum: parts },
    severity: { type: 'string', enum: ['error', 'minor'] },
    what: { type: 'string' },
    fix: { type: 'string' },
    sure: { type: 'boolean' },
  },
  required: [first, 'part', 'severity', 'what', 'fix', 'sure'],
  additionalProperties: false,
})
const SCHEMA = {
  type: 'object',
  properties: {
    lessons: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          terms: { type: 'array', items: finding('term', null, ['読み', '簡単な説明', 'くわしい説明', '別名', '用語']) },
          essay: { type: 'array', items: finding('item', null, ['問い', '解答例', '要点']) },
        },
        required: ['key', 'terms', 'essay'],
        additionalProperties: false,
      },
    },
  },
  required: ['lessons'],
  additionalProperties: false,
}
const schemaFile = join(outDir, 'schema.json')
writeJson(schemaFile, SCHEMA, true)

// まとまり: 科目ごとに、単元表の順で BATCH 件ずつ
const batches = []
{
  const byCourse = new Map()
  // 学び直し版は、別のまとまりにして、あとに回す
  for (const t of targets.filter((x) => !x.deep)) byCourse.set(t.course.id, [...(byCourse.get(t.course.id) ?? []), t])
  for (const t of targets.filter((x) => x.deep)) byCourse.set(`${t.course.id}-deep`, [...(byCourse.get(`${t.course.id}-deep`) ?? []), t])
  for (const [courseId, items] of byCourse) {
    for (let at = 0; at < items.length; at += BATCH) {
      const part = items.slice(at, at + BATCH)
      const input = `${INSTRUCTIONS}\n# 検査するもの（${SCHOOL_LONG[part[0].course.school] ?? ''}・授業 ${part.length} 件）\n\n${part.map(lessonBlock).join('\n\n')}\n`
      batches.push({ id: `${courseId}-${String(at / BATCH + 1).padStart(3, '0')}`, items: part, input, src: hash(`${model}\n${input}`) })
    }
  }
}
const recordFile = (id) => join(batchDir, `${id}.json`)

// ───────── まとめを書き出す ─────────

if (has('report')) {
  report()
  process.exit(0)
}

const todo = batches.filter((b) => has('redo') || readJson(recordFile(b.id), null)?.src !== b.src)
const queue = opt('limit', '') ? todo.slice(0, Number(opt('limit'))) : todo
{
  const terms = targets.reduce((n, t) => n + t.terms.length, 0)
  const essays = targets.filter((t) => t.essay).length
  const chars = queue.reduce((n, b) => n + b.input.length, 0)
  log(`授業 ${targets.length} 件（用語 ${terms} 個、記述・論述のある授業 ${essays} 件）＝ まとまり ${batches.length} 個。これから検査するのは ${queue.length} 個（約 ${Math.round(chars / 10000)} 万字）`)
}
if (has('count')) process.exit(0)

// ───────── codex の呼び出しと、使用量の見はり（tools/deepen-lessons.mjs と同じやり方） ─────────

function codex({ input, schema = '', ephemeral = true, callEffort = effort, timeoutMs = 30 * 60_000 }) {
  return new Promise((done, fail) => {
    const cli = ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--sandbox', 'read-only', '-C', workDir, '-m', model, '-c', `model_reasoning_effort=${callEffort}`]
    if (ephemeral) cli.push('--ephemeral')
    if (schema) cli.push('--output-schema', schema)
    cli.push('-')
    const started = Date.now()
    // ChatGPT のプラン（保存してあるログイン）で動かす。API の鍵は渡さない
    const env = { ...process.env }
    delete env.CODEX_API_KEY
    delete env.OPENAI_API_KEY
    const child = spawn('codex', cli, { cwd: workDir, windowsHide: true, env })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    let buffer = ''
    let stderr = ''
    let message = ''
    let failure = ''
    let usage = null
    let thread = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type === 'thread.started') thread = event.thread_id
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') message = event.item.text ?? message
        if (event.type === 'turn.completed') usage = event.usage
        if (event.type === 'error' || event.type === 'turn.failed') failure = event.message ?? event.error?.message ?? failure
      }
    })
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-1500)))
    child.on('error', (error) => {
      clearTimeout(timer)
      fail(new Error(`codex を起動できませんでした: ${error.message}`))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const seconds = Math.round((Date.now() - started) / 1000)
      if (message && usage) done({ message, usage, seconds, thread })
      else fail(new Error(failure || `codex から返事がありませんでした（コード ${code}、${seconds} 秒）${stderr.trim().slice(-300)}`))
    })
    child.stdin.end(input, 'utf8')
  })
}

/** 週の使用割合を読む: 短い問いを 1 回送り（記録を残す）、その記録に書かれた割合を読んで、記録を消す */
async function codexUsage() {
  const answer = await codex({ input: '「はい」とだけ答えてください。', ephemeral: false, callEffort: 'low', timeoutMs: 3 * 60_000 })
  let limits = null
  const now = new Date()
  for (const d of [now, new Date(now.getTime() - 86_400_000)]) {
    const dir = join(homedir(), '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    const found = existsSync(dir) && readdirSync(dir).find((f) => f.includes(answer.thread))
    if (!found) continue
    const match = [...readFileSync(join(dir, found), 'utf8').matchAll(/"rate_limits":(\{.*?"rate_limit_reached_type":[^}]*\})/g)].pop()
    try {
      if (match) limits = JSON.parse(match[1])
    } catch {}
    break
  }
  if (answer.thread) spawnSync('codex', ['delete', '--force', answer.thread], { windowsHide: true })
  return limits
}

const guard = { percent: null, resetsAt: 0, stop: false, why: '', probing: false, until: 0 }
async function probe() {
  if (guard.probing) return
  guard.probing = true
  try {
    const limits = await codexUsage()
    const windows = [limits?.primary, limits?.secondary].filter(Boolean)
    const worst = windows.sort((a, b) => b.used_percent - a.used_percent)[0]
    if (!worst) return
    const weekly = windows.find((w) => w.window_minutes >= 10000) ?? worst
    guard.percent = weekly.used_percent
    guard.resetsAt = weekly.resets_at * 1000
    if (weekly.used_percent >= CODEX_WEEK) {
      guard.stop = true
      guard.why = `codex の使用割合が ${weekly.used_percent}%（週の枠。回復は ${new Date(weekly.resets_at * 1000).toLocaleString('ja-JP')}）`
    } else if (worst !== weekly && worst.used_percent >= 95) {
      // 短い枠（数時間ごと）が上限に近いときは、やめずに、回復まで待つ
      guard.until = worst.resets_at * 1000 + 60_000
      log(`codex の ${Math.round(worst.window_minutes / 60)} 時間の枠が ${worst.used_percent}% なので、${new Date(guard.until).toLocaleTimeString('ja-JP')} まで待ちます`)
    }
  } catch (error) {
    log(`使用割合を読めませんでした（${String(error.message).slice(0, 100)}）`)
  } finally {
    guard.probing = false
  }
}
const price = (u) => {
  const cached = Number(u?.cached_input_tokens) || 0
  const input = Math.max(0, (Number(u?.input_tokens) || 0) - cached)
  return (input * 2 + cached * 0.1 + (Number(u?.output_tokens) || 0) * 10) / 1e6
}
const parse = (text) => JSON.parse(text.replace(/^```(?:json)?\n?|\n?```$/g, ''))

async function inspect(batch) {
  const answer = await codex({ input: batch.input, schema: schemaFile })
  const result = parse(answer.message)
  const keys = new Set(batch.items.map((t) => t.key))
  const lessons = (result.lessons ?? []).filter((l) => keys.has(l.key))
  if (lessons.length < batch.items.length) throw new Error(`返事に授業が足りません（${lessons.length} / ${batch.items.length}）`)
  writeJson(recordFile(batch.id), { id: batch.id, src: batch.src, at: new Date().toISOString(), model, effort, keys: [...keys], seconds: answer.seconds, usage: answer.usage, lessons })
  appendFileSync(join(outDir, 'metrics.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), id: batch.id, seconds: answer.seconds, usage: answer.usage, cost: +price(answer.usage).toFixed(4) })}\n`, 'utf8')
  return { cost: price(answer.usage), errors: lessons.reduce((n, l) => n + [...l.terms, ...l.essay].filter((f) => f.severity === 'error').length, 0), minors: lessons.reduce((n, l) => n + [...l.terms, ...l.essay].filter((f) => f.severity === 'minor').length, 0) }
}

await probe()
log(`codex の週の使用割合: ${guard.percent ?? '?'}%（${CODEX_WEEK}% で止めます。回復は ${guard.resetsAt ? new Date(guard.resetsAt).toLocaleString('ja-JP') : '不明'}）／ ${model}・${effort}・同時に ${opt('concurrency', 24)} 個`)
let at = 0
let done = 0
let failed = 0
let cost = 0
let sinceProbe = 0
const started = Date.now()
const failures = []
async function worker() {
  while (at < queue.length && !guard.stop) {
    while (Date.now() < guard.until) await sleep(30_000)
    const batch = queue[at++]
    let last = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const r = await inspect(batch)
        cost += r.cost
        done += 1
        last = null
        if (done % 10 === 0 || done === queue.length) log(`${done} / ${queue.length} 個（失敗 ${failed}）— ${batch.id}: 誤り ${r.errors}・軽い ${r.minors} ／ これまでに API 換算 ${cost.toFixed(1)} ドル、${Math.round((Date.now() - started) / 60000)} 分`)
        break
      } catch (error) {
        last = error
        if (/limit|quota|429|usage/i.test(String(error.message))) {
          await probe()
          if (guard.stop) break
          await sleep(60_000)
        }
      }
    }
    if (last) {
      failed += 1
      failures.push(batch.id)
      log(`${batch.id}: 失敗 — ${String(last.message).slice(0, 160)}`)
    }
    sinceProbe += 1
    if (sinceProbe >= PROBE_EVERY) {
      sinceProbe = 0
      await probe()
      if (guard.percent != null) log(`codex の週の使用割合: ${guard.percent}%`)
    }
  }
}
await Promise.all(Array.from({ length: Math.min(Number(opt('concurrency', 24)), queue.length) }, worker))
await probe()
if (guard.stop) log(`${guard.why}なので、ここで止めました。残りは ${queue.length - done - failed} 個`)
log(`終わりました。検査したまとまり ${done} 個（失敗 ${failed}${failures.length ? `: ${failures.slice(0, 12).join(', ')}` : ''}）／ API 換算 ${cost.toFixed(1)} ドル ／ ${Math.round((Date.now() - started) / 60000)} 分 ／ codex の週 ${guard.percent ?? '?'}%`)

// ───────── まとめ ─────────

function report() {
  const dir = resolve(opt('report-dir', join(root, '..', '検査の結果')))
  mkdirSync(dir, { recursive: true })
  const byKey = new Map(targets.map((t) => [t.key, t]))
  const all = []
  let inspected = 0
  let pending = 0
  const seen = new Set()
  for (const b of batches) {
    const record = readJson(recordFile(b.id), null)
    if (!record || record.src !== b.src) {
      pending += 1
      continue
    }
    inspected += 1
    for (const l of record.lessons) {
      const t = byKey.get(l.key)
      if (!t) continue
      seen.add(l.key)
      for (const f of l.terms) all.push({ kind: '用語', key: l.key, school: t.course.school, course: courseTitle(t.course), subject: t.course.subjectLabel, lesson: `${t.number}「${t.title}」${t.deep ? '（学び直し版）' : ''}`, target: f.term, part: f.part, severity: f.severity, sure: f.sure, what: f.what, fix: f.fix })
      for (const f of l.essay) all.push({ kind: '記述・論述', key: l.key, school: t.course.school, course: courseTitle(t.course), subject: t.course.subjectLabel, lesson: `${t.number}「${t.title}」`, target: f.item, part: f.part, severity: f.severity, sure: f.sure, what: f.what, fix: f.fix })
    }
  }
  const lessons = targets.filter((t) => seen.has(t.key))
  const termCount = lessons.reduce((n, t) => n + t.terms.length, 0)
  const problemCount = lessons.reduce((n, t) => n + (t.essay ? (t.essay.short?.length ?? 0) + (t.essay.long?.length ?? 0) : 0), 0)
  const count = (f) => all.filter(f).length
  const rate = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—')
  const uniq = (kind, severity, sureOnly) => new Set(all.filter((f) => f.kind === kind && f.severity === severity && (!sureOnly || f.sure)).map((f) => `${f.key}|${f.target}`)).size
  // 機械の確かめ（字数）
  let shortOut = 0
  let longOut = 0
  let shortAll = 0
  let longAll = 0
  for (const t of lessons) {
    if (!t.essay) continue
    const goal = writingTargets(t.course.school, t.grade)
    for (const q of t.essay.short ?? []) {
      shortAll += 1
      const n = countChars(q.answer)
      if (n < goal.short[0] || n > goal.short[2]) shortOut += 1
    }
    for (const q of t.essay.long ?? []) {
      longAll += 1
      const n = countChars(essayText(q.answer))
      if (n < goal.long[0] || n > goal.long[1]) longOut += 1
    }
  }
  const md = []
  md.push('# 記述・論述の問題と用語集の検査（Codex）', '')
  md.push(`- 検査した日: ${new Date().toLocaleString('ja-JP')}`)
  md.push(`- 検査役: Codex（${model}・思考量 ${effort}）。検査だけで、教材は書きかえていません。`)
  md.push(`- 検査した授業: ${lessons.length} 件（まとまり ${inspected} 個。まだのまとまり ${pending} 個）`)
  md.push(`- 検査したもの: 用語 ${termCount} 個、記述・論述の問題 ${problemCount} 問`, '')
  md.push('## 全体', '')
  md.push('| | 検査した数 | 誤りの指摘がある数（自信あり） | 割合 | 誤りの指摘（自信なしもふくむ） | 軽い指摘がある数 |', '|---|---:|---:|---:|---:|---:|')
  md.push(`| 用語 | ${termCount} | ${uniq('用語', 'error', true)} | ${rate(uniq('用語', 'error', true), termCount)} | ${uniq('用語', 'error', false)} | ${uniq('用語', 'minor', false)} |`)
  md.push(`| 記述・論述の問題 | ${problemCount} | ${uniq('記述・論述', 'error', true)} | ${rate(uniq('記述・論述', 'error', true), problemCount)} | ${uniq('記述・論述', 'error', false)} | ${uniq('記述・論述', 'minor', false)} |`, '')
  md.push('指摘の件数（1 つの用語・問題に、複数の指摘が付くことがあります）:', '')
  md.push('| 種類 | どこ | 誤り | 軽い |', '|---|---|---:|---:|')
  for (const kind of ['用語', '記述・論述']) {
    for (const part of [...new Set(all.filter((f) => f.kind === kind).map((f) => f.part))]) md.push(`| ${kind} | ${part} | ${count((f) => f.kind === kind && f.part === part && f.severity === 'error')} | ${count((f) => f.kind === kind && f.part === part && f.severity === 'minor')} |`)
  }
  md.push('', '## 学校・教科ごと（誤りの指摘がある数）', '')
  md.push('| 学校 | 教科 | 授業 | 用語 | 用語の誤り | 問題 | 問題の誤り |', '|---|---|---:|---:|---:|---:|---:|')
  const groups = new Map()
  for (const t of lessons) {
    const id = `${t.course.school}|${t.course.subjectLabel}`
    const g = groups.get(id) ?? { school: t.course.school, subject: t.course.subjectLabel, lessons: 0, terms: 0, problems: 0 }
    g.lessons += 1
    g.terms += t.terms.length
    g.problems += t.essay ? (t.essay.short?.length ?? 0) + (t.essay.long?.length ?? 0) : 0
    groups.set(id, g)
  }
  for (const g of groups.values()) {
    const own = (kind) => new Set(all.filter((f) => f.kind === kind && f.severity === 'error' && f.school === g.school && f.subject === g.subject).map((f) => `${f.key}|${f.target}`)).size
    md.push(`| ${SCHOOL_LONG[g.school]} | ${g.subject} | ${g.lessons} | ${g.terms} | ${own('用語')} | ${g.problems} | ${own('記述・論述')} |`)
  }
  md.push('', '## 機械の確かめ（字数）', '')
  md.push(`- 記述の解答例: ${shortAll} 問のうち、字数の目安の外が ${shortOut} 問（${rate(shortOut, shortAll)}）`)
  md.push(`- 論述の解答例: ${longAll} 問のうち、字数の目安の外が ${longOut} 問（${rate(longOut, longAll)}）`, '')
  md.push('## 読み方', '')
  md.push('- 「誤り」は、事実・定義・読み・文法の誤り、問いと解答例がかみ合わない、答えが定まらない、学年の範囲を大きくこえる、のどれかです。「軽い」は、言い回し・説明の足りなさ・字数のずれなどです。')
  md.push('- 学校の段階でふつうの簡略化は、指摘しないように頼んであります。それでも、厳しすぎる指摘が混ざることがあります（Codex の指摘は、人の確認を経ていません）。')
  md.push('- 誤りの一覧は「誤りの一覧.md」、すべての指摘は「すべての指摘.json」にあります。')
  writeFileSync(join(dir, 'まとめ.md'), `${md.join('\n')}\n`, 'utf8')

  const errors = all.filter((f) => f.severity === 'error')
  const listing = ['# 誤りの一覧（Codex の検査）', '', `誤りの指摘 ${errors.length} 件。「？」は、Codex が「自信なし」とした指摘です。`, '']
  let course = ''
  let lesson = ''
  for (const f of errors) {
    if (f.course !== course) {
      course = f.course
      lesson = ''
      listing.push('', `## ${course}`)
    }
    if (f.key !== lesson) {
      lesson = f.key
      listing.push('', `### ${f.lesson}（${f.key}）`)
    }
    listing.push(`- ${f.sure ? '' : '？ '}**${f.kind === '用語' ? `用語「${f.target}」` : f.target}・${f.part}**: ${flat(f.what)} → ${flat(f.fix)}`)
  }
  writeFileSync(join(dir, '誤りの一覧.md'), `${listing.join('\n')}\n`, 'utf8')
  writeJson(join(dir, 'すべての指摘.json'), { at: new Date().toISOString(), model, effort, lessons: lessons.length, terms: termCount, problems: problemCount, pending, findings: all }, true)
  console.log(md.slice(0, 16).join('\n'))
  console.log(`\n書き出しました: ${dir}`)
}
