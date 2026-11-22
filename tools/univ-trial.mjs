// 大学・大学院の授業の試作: 科目表に試作の科目を足し、単元表を作り、同じ授業を 4 つのモデルに書かせて、
// できばえ・かかる時間・使う量を比べる。よい版は、アプリの授業として入れる。
//
//   node --no-warnings tools/univ-trial.mjs --catalog                 科目表（resources/content/catalog.json）に、試作の科目（tools/univ-courses.json）を書きこむ
//   node --no-warnings tools/univ-trial.mjs --curricula               単元表を作る（<データ置き場>/curricula/<科目>.json。すでにあるものは作らない）
//   node --no-warnings tools/univ-trial.mjs --write                   比べる授業を、モデルごとに書かせる
//   node --no-warnings tools/univ-trial.mjs --judge                   codex に、どのモデルが書いたかを伏せて評価させる（1 件ずつの評価と、4 つの版の順位づけ）
//   node --no-warnings tools/univ-trial.mjs --classify                評価で付いた「誤り」を、重さ（はっきりした誤り・厳密さの不足・書き方の問題）で分けさせる
//   node --no-warnings tools/univ-trial.mjs --report                  結果の表を出す（<データ置き場>/univ-trial/results.json にも書く）
//   node --no-warnings tools/univ-trial.mjs --fix [--prefer opus]     アプリに入れる版に「本物の誤り」の指摘があれば、書いたモデルに直させて、もう一度評価させる
//   node --no-warnings tools/univ-trial.mjs --install [--prefer opus] 順位がいちばんよい版（--prefer を付けたら、そのモデルの版）を、アプリの授業として入れる
//
//   そのほか: --models fable,opus,sonnet,haiku  --effort medium  --curriculum-model opus  --judge-model gpt-6.2-sol  --only <科目の ID,…>  --per-course 1
//
// - AI は、この PC の claude・codex のコマンドで呼ぶ（API キーは使わない。自分のプランの使用量を使う）。
// - 指示文は、アプリが授業を作るときのもの（src/main/ai/authoring.ts）をそのまま使う。アプリの「教材づくり」で作るのと同じ条件になる。
// - 使う量は、コマンドが知らせてくるトークンの数と、「API で同じことをしたときの料金」で比べる。
// - 授業を入れるのは、アプリが閉じているときだけ（授業の記録をアプリと同時に書くと、こわれるため）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkLesson } from '../scripts/lib/check-lesson.mjs'
import { CLAUDE_MODELS, costOf } from '../src/web/ai/providers.ts'
import { runClaude, runCodex, setupCli } from '../web/cli.mjs'

const args = process.argv.slice(2)
const has = (name) => args.includes(`--${name}`)
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : fallback
}
const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const outDir = join(dataDir, 'univ-trial')
const models = opt('models', 'fable,opus,sonnet,haiku').split(',').filter(Boolean)
const effort = opt('effort', 'medium')
const curriculumModel = opt('curriculum-model', 'opus')
const judgeModel = opt('judge-model', 'gpt-6.2-sol')
const only = opt('only', '').split(',').filter(Boolean)
const perCourse = Number(opt('per-course', 1))
for (const dir of ['drafts', 'judge', 'rank', 'raw']) mkdirSync(join(outDir, dir), { recursive: true })
setupCli({ workDir: join(outDir, 'workdir'), tempDir: join(outDir, 'temp') })

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 1), 'utf8')
const log = (...parts) => console.log(new Date().toLocaleTimeString('ja-JP'), ...parts)
const plainLength = (text) => text.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, '').length
/**
 * モデルの返事から、本文を取り出す。
 * - 全体を ``` で囲んで返すことがあるので、外す
 * - Fable が、本文の前に「[Fable 5.2 here]」「<reasoning_effort>10</reasoning_effort>」のような印や、考えのメモを付けることがあるので、外す
 *   （2026-11-19 の試しで、Fable の 22 回の呼び出しのうち 3 回。ほかに 2 回は、本文が出なかった）
 */
function lessonBody(text) {
  let body = text.trim().replace(/^```(?:markdown)?\n([\s\S]*)\n```$/, '$1')
  // 先頭の印（[…] や <…>…</…>）を外す
  body = body.replace(/^(?:\s*(?:<([a-z_]{1,30})>[^<\n]{0,60}<\/\1>|\[[^\]\n]{1,40}\]))+\s*(?=# )/, '')
  // 最初の「# 」の見出しより前に、考えのメモなどの前置きが付いていたら、外す（Fable で、22 回のうち 1 回あった）。
  // 前置きにしては長いものや、見出し・コードブロックをふくむものは、本文の一部かもしれないので、さわらない
  const at = body.search(/^# \S/m)
  if (at > 0) {
    const before = body.slice(0, at)
    if (before.length <= 3000 && !/^## |```/m.test(before)) body = body.slice(at)
  }
  return body
}
/** アプリは、1 行に書いた $$…$$ の中の \tag を表示できない。式の終わりの番号に書きかえる */
const untag = (text) => text.replace(/\\tag\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_all, label) => `\\qquad\\cdots(${label.replace(/\$/g, '')})`)
const user = (text) => [{ role: 'user', content: [{ type: 'text', text }] }]

// アプリの指示文を、そのまま読みこむ（@shared/… と、拡張子の無い読みこみを、Node が分かる形にする）
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@shared/')) return nextResolve(pathToFileURL(join(root, 'src', 'shared', `${specifier.slice(8)}${extname(specifier) ? '' : '.ts'}`)).href, context)
    if (/^\.\.?\//.test(specifier) && !extname(specifier) && context.parentURL?.includes('/src/')) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})
const A = await import('../src/main/ai/authoring.ts')

// ───────── 科目 ─────────

const trial = readJson(join(root, 'tools', 'univ-courses.json'), null)
if (!trial) throw new Error('tools/univ-courses.json を読めません。')
const SCHOOL = trial.schools
/** アプリの中での科目の形（src/main/content.ts の toCourse と同じもの） */
const toCourse = (c) => ({
  id: c.id,
  school: c.school,
  schoolLabel: SCHOOL[c.school],
  subject: c.subject,
  subjectLabel: c.subjectLabel,
  label: c.label,
  title: `${SCHOOL[c.school]} ${c.label}（${c.subjectLabel}）`,
  subjectId: `${c.school}-${c.subject}`,
  scope: c.scope,
  lessonTarget: c.lessons,
  hasDeep: false,
  guide: c.guide ?? c.subject,
  vocational: false,
  higher: true,
  skill: false,
  practice: false,
})
const courses = trial.courses.filter((c) => !only.length || only.includes(c.id)).map(toCourse)
const curriculumFile = (id) => join(dataDir, 'curricula', `${id}.json`)
/** 単元表を、アプリの中での形（番号と ID つき）にする */
function unitsOf(course) {
  const file = readJson(curriculumFile(course.id), null)
  if (!file) return null
  return file.units.map((unit, u) => ({
    number: u + 1,
    domain: unit.domain ?? '',
    title: unit.title,
    summary: unit.summary,
    lessons: unit.lessons.map((lesson, l) => ({ id: `${course.id}-${u + 1}-${l + 1}`, number: `${u + 1}-${l + 1}`, title: lesson.title, summary: lesson.summary })),
  }))
}
/** 比べる授業: まん中の単元の、まん中あたりの授業（最初の授業は導入で、ちがいが出にくい） */
function picks(course) {
  const units = unitsOf(course)
  if (!units) return []
  const chosen = []
  for (let i = 0; i < perCourse; i += 1) {
    const unit = units[Math.min(units.length - 1, Math.floor(units.length / 2) + i)]
    const lesson = unit.lessons[Math.min(unit.lessons.length - 1, Math.floor(unit.lessons.length / 2))]
    if (!chosen.some((x) => x.lesson.id === lesson.id)) chosen.push({ course, units, unit, lesson })
  }
  return chosen
}
const modelId = (name) => CLAUDE_MODELS[name] ?? name

async function pool(jobs, size, run) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++]
        try {
          await run(job)
        } catch (error) {
          log('失敗:', job.name ?? '', String(error?.message ?? error).slice(0, 200))
        }
      }
    }),
  )
}

// ───────── 科目表に書きこむ ─────────

if (has('catalog')) {
  const file = join(root, 'resources', 'content', 'catalog.json')
  // 科目表は「1 行に 1 科目」の形で書いてあるので、その形のまま、行を足す・入れかえる
  const raw = readFileSync(file, 'utf8')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const oneLine = (value) => `{ ${Object.entries(value).map(([key, v]) => `${JSON.stringify(key)}: ${JSON.stringify(v)}`).join(', ')} }`
  const ids = new Set(trial.courses.map((c) => c.id))
  const lines = raw.replaceAll('\r\n', '\n').trimEnd().split('\n')
  const kept = lines.filter((line) => !ids.has(/^\s*\{ "id": "([^"]+)"/.exec(line)?.[1] ?? ''))
  const end = kept.lastIndexOf('  ]')
  const schoolsAt = kept.findIndex((line) => line.startsWith('  "schools":'))
  if (end < 0 || schoolsAt < 0 || kept.at(-1) !== '}') throw new Error('科目表の形が、思っていたものとちがいます。')
  kept[schoolsAt] = `  "schools": ${oneLine({ ...JSON.parse(raw).schools, ...trial.schools })},`
  kept[end - 1] = kept[end - 1].replace(/,?$/, ',')
  kept.splice(end, 0, ...trial.courses.map((c, i) => `    ${oneLine(c)}${i < trial.courses.length - 1 ? ',' : ''}`))
  const text = `${kept.join(eol)}${eol}`
  const parsed = JSON.parse(text)
  if (parsed.courses.length !== new Set(parsed.courses.map((c) => c.id)).size) throw new Error('科目の ID が重なっています。')
  writeFileSync(file, text, 'utf8')
  log(`科目表に書きこみました（試作の科目 ${trial.courses.length}、合計 ${parsed.courses.length}）`)
}

// ───────── 単元表 ─────────

if (has('curricula')) {
  mkdirSync(join(dataDir, 'curricula'), { recursive: true })
  const jobs = courses.filter((course) => !existsSync(curriculumFile(course.id))).map((course) => ({ name: course.id, course }))
  log(`単元表を作ります（${jobs.length} 科目、${curriculumModel}）`)
  await pool(jobs, 4, async ({ course }) => {
    const began = Date.now()
    const result = await runClaude({ model: modelId(curriculumModel), effort: 'high', system: A.curriculumSystemPrompt(course), turns: user(A.curriculumUserPrompt(course)), jsonSchema: A.CURRICULUM_SCHEMA })
    const file = JSON.parse(result.text)
    const count = file.units.reduce((sum, unit) => sum + unit.lessons.length, 0)
    if (!file.units?.length || Math.abs(count - course.lessonTarget) > 4) throw new Error(`${course.id}: 授業の数が目安（${course.lessonTarget}）から離れています（${count}）`)
    writeJson(curriculumFile(course.id), file)
    log(`${course.id}: 単元 ${file.units.length}、授業 ${count} 回（${Math.round((Date.now() - began) / 1000)} 秒、${result.usage.output} トークン、${(result.cost ?? 0).toFixed(3)} ドル）`)
  })
}

// ───────── 書かせる ─────────

const metricsFile = join(outDir, 'metrics.json')
const metrics = readJson(metricsFile, {})
const draftFile = (model, id) => join(outDir, 'drafts', `${id}.${model}.md`)

if (has('write')) {
  const targets = courses.flatMap(picks)
  log(`授業を書かせます（${targets.length} 件 × ${models.length} モデル、思考量 ${effort}）`)
  // モデルごとに 2 件ずつ進める（時間を、ほかのモデルの混み具合に左右されにくくする）
  await Promise.all(
    models.map((model) =>
      pool(
        targets.filter((x) => !existsSync(draftFile(model, x.lesson.id))).map((x) => ({ name: `${model} ${x.lesson.id}`, ...x })),
        2,
        async ({ course, units, unit, lesson }) => {
          const began = Date.now()
          const result = await runClaude({ model: modelId(model), effort, system: A.lessonSystemPrompt(course, 'standard'), turns: user(A.lessonUserPrompt(course, units, unit, lesson)) })
          const body = lessonBody(result.text)
          if (plainLength(body) < 800) {
            writeFileSync(join(outDir, 'raw', `short-${lesson.id}.${model}.txt`), `${JSON.stringify(result.usage)}\n${result.text}`, 'utf8')
            throw new Error(`本文が短すぎます（${plainLength(body)} 字）: ${body.slice(0, 80)}`)
          }
          writeFileSync(draftFile(model, lesson.id), `${body}\n`, 'utf8')
          const found = checkLesson(body)
          metrics[`${lesson.id}.${model}`] = {
            lesson: lesson.id,
            model,
            effort,
            seconds: Math.round((Date.now() - began) / 1000),
            input: result.usage.input,
            output: result.usage.output,
            cost: result.cost ?? costOf(modelId(model), result.usage),
            chars: plainLength(body),
            errors: found.filter((x) => x.level === 'error').map((x) => x.message),
            warns: found.filter((x) => x.level === 'warn').map((x) => x.message),
          }
          writeJson(metricsFile, metrics)
          const m = metrics[`${lesson.id}.${model}`]
          log(`${model} ${lesson.id}（${lesson.title}）: ${m.seconds} 秒、${m.chars} 字、出力 ${m.output} トークン、${m.cost.toFixed(3)} ドル${m.errors.length ? `、検査の誤り ${m.errors.length}` : ''}`)
        },
      ),
    ),
  )
}

// ───────── 評価させる ─────────

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'object',
      properties: Object.fromEntries(['accuracy', 'level', 'depth', 'clarity', 'exercises'].map((key) => [key, { type: 'integer', minimum: 1, maximum: 5 }])),
      required: ['accuracy', 'level', 'depth', 'clarity', 'exercises'],
      additionalProperties: false,
    },
    real_errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: { where: { type: 'string' }, what: { type: 'string' }, fix: { type: 'string' }, sure: { type: 'boolean' } },
        required: ['where', 'what', 'fix', 'sure'],
        additionalProperties: false,
      },
    },
    unverifiable: { type: 'array', items: { type: 'string' } },
    minor: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['scores', 'real_errors', 'unverifiable', 'minor', 'summary'],
  additionalProperties: false,
}
const RANK_SCHEMA = {
  type: 'object',
  properties: {
    order: { type: 'array', items: { type: 'string', enum: ['A', 'B', 'C', 'D'] } },
    reasons: { type: 'object', properties: Object.fromEntries(['A', 'B', 'C', 'D'].map((key) => [key, { type: 'string' }])), required: ['A', 'B', 'C', 'D'], additionalProperties: false },
    usable: { type: 'array', items: { type: 'string', enum: ['A', 'B', 'C', 'D'] } },
  },
  required: ['order', 'reasons', 'usable'],
  additionalProperties: false,
}
const stage = (course) => (course.school === 'grad' ? '大学院（修士課程）' : '大学（学部）')
const about = ({ course, unit, lesson }) => `科目: ${stage(course)} ${course.subjectLabel}「${course.label}」
科目の範囲: ${course.scope}
単元: ${unit.title}
授業: ${lesson.number} ${lesson.title}
この授業で扱う内容: ${lesson.summary}
読み手: ${course.school === 'grad' ? '修士課程の 1 年生。学部の標準的な内容は前提にしてよい' : '学部でこの科目をはじめて学ぶ学生。高校までの内容は前提にしてよい'}
分量のねらい: ${course.school === 'grad' ? '4,000〜6,000' : '3,500〜5,000'} 字（講義 1 回ぶん）`

const judgeSystem = (target) => `あなたは、${stage(target.course)}でこの分野を教えている教員で、教科書の校閲もしています。学習アプリにのせる授業の本文（講義 1 回ぶん。ひとりで読んで学ぶもの）を、きびしく、公平に評価します。だれが書いたかは知らされません。

# 評価のしかた
- 本文の事実・定義・定理・証明・導出・計算・コード・条文・判例・研究の紹介・確かめ問題の答えを、自分で 1 つずつ確かめます。計算は解き直し、証明は 1 行ずつ追い、コードは小さな入力で動かして確かめます。
- 「本物の誤り」と「軽微な点」を分けます。
  - 本物の誤り（real_errors）: 学生がそのまま覚えると、まちがった理解や誤答になるもの。誤った定理・定義、成り立たない証明、まちがった計算や答え、動かないコード、存在しない条文・判例・研究、事実とちがう人名や年、仮定を落としたために偽になっている主張。確かにそう言えるものは sure を true、疑わしいが確かめきれないものは false にします。
  - 軽微な点（minor）: 言い回し、説明の順序、入門としてふつうの簡略化、もう少しくわしく書けるところ。
- unverifiable には、本文に書かれているが、実在するか・正しいかを自分では確かめきれなかった固有の事実（人名、年、数値、文献、条文の番号、判例の日付など）を書きます。
- 点数（1〜5 の整数。3 が「そのまま使える最低の水準」）
  - accuracy: 内容の正しさ（本物の誤りが 1 つでもあれば 3 以下、複数あれば 2 以下）
  - level: この段階の講義として、水準が合っているか（やさしすぎる・高校の内容にとどまる、または先へ進みすぎる・前提が足りない、は低い）
  - depth: 講義 1 回ぶんとして、扱う内容が足りているか。理由（証明、導出、根拠）まで示しているか
  - clarity: ひとりで読んで分かるか。定義から積み上げているか、例が適切か
  - exercises: 例題と確かめ問題の質（計算・説明・証明・あてはめがあるか、答えと考え方が正しく付いているか）
- summary: 全体の評価を 2〜3 文で。`

async function codex(system, text, schema, name) {
  const began = Date.now()
  const result = await runCodex({ model: judgeModel, effort: 'high', system, turns: user(text), jsonSchema: schema })
  writeFileSync(join(outDir, 'raw', `${name}.txt`), result.text, 'utf8')
  return { value: JSON.parse(result.text), seconds: Math.round((Date.now() - began) / 1000), usage: result.usage }
}

if (has('judge')) {
  const targets = courses.flatMap(picks)
  const jobs = targets.flatMap((target) => models.filter((model) => existsSync(draftFile(model, target.lesson.id)) && !existsSync(join(outDir, 'judge', `${target.lesson.id}.${model}.json`))).map((model) => ({ name: `評価 ${target.lesson.id} ${model}`, target, model })))
  log(`1 件ずつ評価させます（${jobs.length} 件、${judgeModel}）`)
  await pool(jobs, 4, async ({ target, model }) => {
    const body = readFileSync(draftFile(model, target.lesson.id), 'utf8')
    const { value, seconds } = await codex(judgeSystem(target), `${about(target)}\n\n# 評価する本文\n\n${body}`, JUDGE_SCHEMA, `judge-${target.lesson.id}.${model}`)
    writeJson(join(outDir, 'judge', `${target.lesson.id}.${model}.json`), value)
    log(`評価 ${target.lesson.id} ${model}: ${seconds} 秒、点 ${Object.values(value.scores).join('/')}、本物の誤り ${value.real_errors.filter((e) => e.sure).length}（疑い ${value.real_errors.filter((e) => !e.sure).length}）`)
  })

  // 4 つの版を、名前を伏せて並べ、順位をつけさせる（並べる順は、授業ごとに変える）
  const rankJobs = targets.filter((target) => models.every((model) => existsSync(draftFile(model, target.lesson.id))) && !existsSync(join(outDir, 'rank', `${target.lesson.id}.json`))).map((target) => ({ name: `順位 ${target.lesson.id}`, target }))
  log(`順位をつけさせます（${rankJobs.length} 件）`)
  await pool(rankJobs, 3, async ({ target }) => {
    const seed = [...target.lesson.id].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 9973, 7)
    const order = models.map((model, i) => ({ model, key: (seed * (i + 3) * 7919) % 104729 })).sort((a, b) => a.key - b.key).map((x) => x.model)
    const letters = ['A', 'B', 'C', 'D'].slice(0, order.length)
    const text = `${about(target)}\n\n同じ授業を、別々の書き手が書いた ${order.length} つの版です。学習アプリにのせる授業として、よい順に並べてください。\n- いちばん重く見るのは、内容の正しさです。本物の誤り（学生がまちがって覚えるもの）がある版は、ほかがよくても下にします。\n- 次に、この段階の講義としての水準と深さ、ひとりで読んで分かるか、例題と確かめ問題の質を見ます。分量が多いだけでは上にしません。\n- order: よい順に、版の記号を並べる（全部の版を 1 回ずつ）。reasons: 版ごとに、よい点と問題点を 1〜2 文で。usable: 直さずにそのままのせてよい版の記号（無ければ空）。\n\n${order.map((model, i) => `════════ 版 ${letters[i]} ════════\n\n${readFileSync(draftFile(model, target.lesson.id), 'utf8')}`).join('\n\n')}`
    const { value, seconds } = await codex(`あなたは、${stage(target.course)}でこの分野を教えている教員で、教科書の校閲もしています。だれが書いたかは知らされません。きびしく、公平に比べます。事実・証明・計算・コード・条文は、自分で確かめます。`, text, RANK_SCHEMA, `rank-${target.lesson.id}`)
    const map = Object.fromEntries(letters.map((letter, i) => [letter, order[i]]))
    writeJson(join(outDir, 'rank', `${target.lesson.id}.json`), { order: value.order.map((letter) => map[letter]), usable: value.usable.map((letter) => map[letter]), reasons: Object.fromEntries(Object.entries(value.reasons).map(([letter, reason]) => [map[letter], reason])) })
    log(`順位 ${target.lesson.id}: ${value.order.map((letter) => map[letter]).join(' > ')}（${seconds} 秒）`)
  })
}

// ───────── 指摘の重さを分ける ─────────

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: { type: 'object', properties: { n: { type: 'integer' }, kind: { type: 'string', enum: ['wrong', 'rigor', 'style'] } }, required: ['n', 'kind'], additionalProperties: false },
    },
  },
  required: ['items'],
  additionalProperties: false,
}
const classifyFile = (id) => join(outDir, 'classify', `${id}.json`)

if (has('classify')) {
  // 評価で「本物の誤り」とされた指摘を、重さで 3 つに分けさせる（どの版への指摘かは伏せ、順番もまぜる）
  mkdirSync(join(outDir, 'classify'), { recursive: true })
  const jobs = courses.flatMap(picks).filter((target) => !existsSync(classifyFile(target.lesson.id))).map((target) => ({ name: `重さ ${target.lesson.id}`, target }))
  log(`指摘の重さを分けさせます（${jobs.length} 件）`)
  await pool(jobs, 4, async ({ target }) => {
    const id = target.lesson.id
    const all = models.flatMap((model) => (readJson(join(outDir, 'judge', `${id}.${model}.json`), null)?.real_errors ?? []).map((e, i) => ({ model, i, text: `${e.where}: ${e.what}` })))
    const mixed = all.map((x, k) => ({ ...x, key: (k * 7919 + 13) % 10007 })).sort((a, b) => a.key - b.key)
    if (!mixed.length) return writeJson(classifyFile(id), {})
    const text = `${about(target)}\n\nこの授業のいくつかの版に、校閲者が付けた指摘です。指摘を 1 つずつ、次の 3 つのどれかに分けてください。\n- wrong（はっきりした誤り）: 答え・計算・証明・コード・定義・定理・条文・判例・研究の紹介・事実が、まちがっている。または、本文の中で食いちがっている。学生がそのまま覚えると、誤答やまちがった理解になる。\n- rigor（厳密さの不足）: 言っていることはおおむね正しいが、仮定や当てはまる範囲、特別な場合（空の入力、境界、例外など）を言い落としている。または、少し言いすぎている。入門の教科書や講義でも、よくある書き方。\n- style（書き方の問題）: 言い回しや構成の問題で、内容の誤りではない。\n\n# 指摘\n${mixed.map((x, k) => `${k + 1}. ${x.text}`).join('\n')}`
    const { value } = await codex(`あなたは、${stage(target.course)}でこの分野を教えている教員です。校閲の指摘の重さを、公平に分けます。`, text, CLASSIFY_SCHEMA, `classify-${id}`)
    const out = {}
    for (const item of value.items) {
      const x = mixed[item.n - 1]
      if (x) ((out[x.model] ??= [])[x.i] = item.kind)
    }
    writeJson(classifyFile(id), out)
    log(`重さ ${id}: ${models.map((model) => `${model} ${(out[model] ?? []).filter((k) => k === 'wrong').length}/${(out[model] ?? []).length}`).join('  ')}（はっきりした誤り / 指摘）`)
  })
}

// ───────── 結果 ─────────

function collect() {
  const targets = courses.flatMap(picks)
  const rows = []
  for (const target of targets) {
    const rank = readJson(join(outDir, 'rank', `${target.lesson.id}.json`), null)
    for (const model of models) {
      const saved = metrics[`${target.lesson.id}.${model}`]
      if (!saved || !existsSync(draftFile(model, target.lesson.id))) continue
      // 機械の検査は、いまの本文で、やり直す
      const found = checkLesson(readFileSync(draftFile(model, target.lesson.id), 'utf8'))
      const m = { ...saved, errors: found.filter((x) => x.level === 'error').map((x) => x.message), warns: found.filter((x) => x.level === 'warn').map((x) => x.message) }
      const judge = readJson(join(outDir, 'judge', `${target.lesson.id}.${model}.json`), null)
      const kinds = (readJson(classifyFile(target.lesson.id), null) ?? {})[model] ?? null
      const count = (kind) => (kinds ? kinds.filter((k) => k === kind).length : null)
      rows.push({ ...m, wrong: readJson(classifyFile(target.lesson.id), null) ? count('wrong') ?? 0 : null, rigor: readJson(classifyFile(target.lesson.id), null) ? count('rigor') ?? 0 : null, course: target.course.id, school: target.course.school, field: target.course.subject, title: target.lesson.title, scores: judge?.scores ?? null, sure: judge ? judge.real_errors.filter((e) => e.sure).length : null, unsure: judge ? judge.real_errors.filter((e) => !e.sure).length : null, unverifiable: judge?.unverifiable.length ?? null, rank: rank ? rank.order.indexOf(model) + 1 : null, usable: rank ? rank.usable.includes(model) : null })
    }
  }
  return rows
}
const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : NaN)

if (has('report')) {
  const rows = collect()
  const summary = {}
  for (const model of models) {
    const mine = rows.filter((row) => row.model === model)
    const judged = mine.filter((row) => row.scores)
    const ranked = mine.filter((row) => row.rank)
    summary[model] = {
      lessons: mine.length,
      seconds: Math.round(avg(mine.map((row) => row.seconds))),
      chars: Math.round(avg(mine.map((row) => row.chars))),
      output: Math.round(avg(mine.map((row) => row.output))),
      input: Math.round(avg(mine.map((row) => row.input))),
      cost: +avg(mine.map((row) => row.cost)).toFixed(4),
      checkErrors: mine.reduce((sum, row) => sum + row.errors.length, 0),
      scores: judged.length ? Object.fromEntries(Object.keys(judged[0].scores).map((key) => [key, +avg(judged.map((row) => row.scores[key])).toFixed(2)])) : null,
      total: judged.length ? +avg(judged.map((row) => avg(Object.values(row.scores)))).toFixed(2) : null,
      sureErrors: judged.reduce((sum, row) => sum + row.sure, 0),
      unsureErrors: judged.reduce((sum, row) => sum + row.unsure, 0),
      clean: judged.filter((row) => row.sure === 0).length,
      // 指摘を重さで分けたあとの数（--classify をしたとき）
      wrong: judged.every((row) => row.wrong !== null) ? judged.reduce((sum, row) => sum + row.wrong, 0) : null,
      rigor: judged.every((row) => row.rigor !== null) ? judged.reduce((sum, row) => sum + row.rigor, 0) : null,
      noWrong: judged.every((row) => row.wrong !== null) ? judged.filter((row) => row.wrong === 0).length : null,
      unverifiable: judged.reduce((sum, row) => sum + row.unverifiable, 0),
      rank: ranked.length ? +avg(ranked.map((row) => row.rank)).toFixed(2) : null,
      first: ranked.filter((row) => row.rank === 1).length,
      usable: ranked.filter((row) => row.usable).length,
    }
  }
  writeJson(join(outDir, 'results.json'), { at: new Date().toISOString(), effort, judgeModel, summary, rows })
  console.log(JSON.stringify(summary, null, 1))
  console.log('\n授業ごと（順位 / 確かな誤りの数 / 点の平均）')
  for (const id of [...new Set(rows.map((row) => row.lesson))]) {
    const mine = rows.filter((row) => row.lesson === id)
    console.log(`${id} ${mine[0].title}: ${mine.map((row) => `${row.model} ${row.rank ?? '-'}位/${row.sure ?? '-'}/${row.scores ? avg(Object.values(row.scores)).toFixed(1) : '-'}`).join('  ')}`)
  }
}

// ───────── 指摘された誤りを直す ─────────

/** アプリに入れる版を選ぶ: --prefer のモデルの版。無ければ、順位がいちばんよい版 */
function chosen(id) {
  const prefer = opt('prefer', '')
  if (prefer && existsSync(draftFile(prefer, id))) return prefer
  return readJson(join(outDir, 'rank', `${id}.json`), null)?.order.find((name) => existsSync(draftFile(name, id))) ?? null
}
const finalFile = (id) => join(outDir, 'drafts', `${id}.final.md`)

if (has('fix')) {
  // 選んだ版に、評価で「本物の誤り」が付いていたら、書いたモデルに直させて、もう一度評価させる
  const jobs = courses.flatMap(picks).map((target) => {
    const model = chosen(target.lesson.id)
    const judge = model ? readJson(join(outDir, 'judge', `${target.lesson.id}.${model}.json`), null) : null
    return { name: `直し ${target.lesson.id}`, target, model, judge }
  }).filter((job) => job.judge?.real_errors.length && !existsSync(finalFile(job.target.lesson.id)))
  log(`誤りを直させます（${jobs.length} 件）`)
  await pool(jobs, 3, async ({ target, model, judge }) => {
    const id = target.lesson.id
    const body = readFileSync(draftFile(model, id), 'utf8')
    const list = judge.real_errors.map((e, i) => `${i + 1}. ${e.sure ? '【誤り】' : '【誤りの疑い。自分で確かめて、誤りなら直す。正しければ、そのままにする】'} ${e.where}: ${e.what}\n   直し方の案: ${e.fix}`).join('\n')
    const began = Date.now()
    const result = await runClaude({
      model: modelId(model),
      effort,
      system: `${A.lessonSystemPrompt(target.course, 'standard')}\n\n# 今回の仕事\nすでに書いた本文に、校閲者から指摘がありました。指摘された点を自分でも確かめたうえで直し、直したあとの本文の全文を出力します。指摘されていないところは、変えません。構成・見出し・分量は保ちます。`,
      turns: user(`${A.lessonUserPrompt(target.course, target.units, target.unit, target.lesson)}\n\n# 校閲者からの指摘\n${list}\n\n# いまの本文\n\n${body}`),
    })
    const fixed = lessonBody(result.text)
    if (plainLength(fixed) < plainLength(body) * 0.7) {
      writeFileSync(join(outDir, 'raw', `short-fix-${id}.${model}.txt`), `${JSON.stringify(result.usage)}\n${result.text}`, 'utf8')
      throw new Error(`直したあとの本文が短すぎます（${plainLength(fixed)} 字）: ${fixed.slice(0, 80)}`)
    }
    const again = await codex(judgeSystem(target), `${about(target)}\n\n# 評価する本文\n\n${fixed}`, JUDGE_SCHEMA, `judge-${id}.final`)
    writeFileSync(finalFile(id), `${fixed}\n`, 'utf8')
    writeJson(join(outDir, 'judge', `${id}.final.json`), { ...again.value, from: model, fixSeconds: Math.round((Date.now() - began) / 1000), fixCost: result.cost, fixOutput: result.usage.output })
    log(`直し ${id}（${model}）: 確かな誤り ${judge.real_errors.filter((e) => e.sure).length} → ${again.value.real_errors.filter((e) => e.sure).length}、点 ${Object.values(again.value.scores).join('/')}`)
  })
}

// ───────── アプリに入れる ─────────

function appOpen() {
  const script = "(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'electron.exe' -or $_.Name -eq '学びアイ.exe') -and ($_.ExecutablePath -like '*学びアイ*' -or $_.CommandLine -like '*学びアイ*') } | Measure-Object).Count"
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
  return !(result.status === 0 && Number(String(result.stdout ?? '').trim()) === 0)
}

if (has('install')) {
  if (appOpen()) {
    log('アプリが開いているので、授業を入れません。アプリを閉じてから、もう一度実行してください。')
    process.exit(2)
  }
  const lessonsDir = join(dataDir, 'lessons')
  const indexFile = join(dataDir, 'lessons-index.json')
  const index = readJson(indexFile, {})
  let count = 0
  for (const target of courses.flatMap(picks)) {
    const id = target.lesson.id
    const model = chosen(id)
    if (!model) continue
    // 直した版があり、確かな誤りが増えていなければ、直した版を入れる
    const first = readJson(join(outDir, 'judge', `${id}.${model}.json`), null)
    const fixed = existsSync(finalFile(id)) ? readJson(join(outDir, 'judge', `${id}.final.json`), null) : null
    const sureOf = (j) => (j ? j.real_errors.filter((e) => e.sure).length : 99)
    const useFixed = !!fixed && fixed.from === model && sureOf(fixed) <= sureOf(first)
    const judge = useFixed ? fixed : first
    writeFileSync(join(lessonsDir, `${id}.md`), untag(readFileSync(useFixed ? finalFile(id) : draftFile(model, id), 'utf8')), 'utf8')
    index[id] = { ...(index[id] ?? {}), at: Date.now(), reviewed: false }
    if (judge) {
      const sure = judge.real_errors.filter((e) => e.sure)
      writeJson(join(lessonsDir, `${id}.review.json`), { by: 'Codex', at: Date.now(), verdict: sure.length ? 'flag' : 'ok', note: `${model} が書いた試作の授業を、Codex（${judgeModel}）が評価しました。${useFixed ? '指摘された点を直したあと、もう一度評価しています。' : ''}${sure.length ? `確かめてほしい点: ${sure.map((e) => `${e.where}: ${e.what}`).join(' / ')}` : judge.summary}`.slice(0, 600) })
    }
    count += 1
    log(`${id}: ${model} の版を入れました`)
  }
  if (count) writeFileSync(indexFile, JSON.stringify(index), 'utf8')
  log(`${count} 件を入れました`)
}
