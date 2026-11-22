// 授業の本文のほかの教材（科目表・登場人物・単元表・画像の説明・人物の名前）を外国語に訳す。
//
//   node tools/translate-data.mjs [--lang en] --catalog      科目表 → resources/content/catalog.<言語>.json
//   node tools/translate-data.mjs --characters               登場人物 → resources/content/characters.<言語>.json
//   node tools/translate-data.mjs --curricula                単元表 → <データ置き場>/i18n/<言語>/curricula/<科目>.json（同梱の科目は curriculum.<言語>.json）
//   node tools/translate-data.mjs --media                    画像の説明 → <データ置き場>/i18n/<言語>/media.json
//   node tools/translate-data.mjs --names                    掛け合いに出る人物の名前の表を、授業の訳の記録から作り直す → i18n/<言語>/people.json（AI は使わない）
//   node tools/translate-data.mjs --titles                   訳した授業の題（# の見出し）を、単元表の授業の題にそろえる（AI は使わない）
//
// すでに訳してあるものは飛ばす（--redo で作り直す）。授業の本文は tools/translate-lessons.mjs。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CAST, TRANSLATION_LANGS } from '../src/shared/translate.ts'

const args = process.argv.slice(2)
const opt = (name, fallback) => (args.indexOf(`--${name}`) >= 0 ? args[args.indexOf(`--${name}`) + 1] : fallback)
const has = (name) => args.includes(`--${name}`)
const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const lang = opt('lang', 'en')
if (!TRANSLATION_LANGS[lang]) throw new Error(`まだ用意していない言語です: ${lang}`)
const NAME = TRANSLATION_LANGS[lang].name
const content = join(root, 'resources', 'content')
const outRoot = join(dataDir, 'i18n', lang)
const tempDir = join(dataDir, 'ai-temp')
for (const dir of [outRoot, tempDir, join(outRoot, 'curricula')]) mkdirSync(dir, { recursive: true })
const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 1) + '\n', 'utf8')

function ask(system, user, schema) {
  return new Promise((done, fail) => {
    const systemFile = join(tempDir, `data-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
    writeFileSync(systemFile, system, 'utf8')
    const cli = ['-p', '--output-format', 'json', '--model', opt('model', 'sonnet'), '--effort', 'low', '--system-prompt-file', systemFile, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--setting-sources', '', '--json-schema', JSON.stringify(schema)]
    const child = spawn('claude', cli, { cwd: tempDir, windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('error', fail)
    child.on('exit', () => {
      try {
        const result = JSON.parse(out)
        if (result.is_error) return fail(new Error(String(result.result).slice(0, 200)))
        done(result.structured_output ?? JSON.parse(result.result))
      } catch {
        fail(new Error(`返答を読み取れません: ${out.slice(0, 200)}`))
      }
    })
    child.stdin.end(user, 'utf8')
  })
}
async function retry(work, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await work()
    } catch (error) {
      console.log(`${label}: 失敗（${attempt} 回目）${String(error.message).slice(0, 120)}`)
    }
  }
  return null
}
async function pool(jobs, size, work) {
  let next = 0
  let done = 0
  await Promise.all(
    Array.from({ length: Math.min(size, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++]
        await work(job)
        if (++done % 10 === 0 || done === jobs.length) console.log(`${done} / ${jobs.length}`)
      }
    }),
  )
}

const BASE = `You translate data of "学びアイ" (Manabi-Ai), a Japanese learning app that follows Japan's national curriculum (the Course of Study) for elementary, junior high, and high school, into ${NAME}. The readers are students. Translate faithfully and naturally; do not add or drop content. For things specific to Japan (people, places, eras, works, laws, school subjects), use the usual ${NAME} name.`

const catalog = readJson(join(content, 'catalog.json'))

// ───────── 科目表 ─────────
const SCHOOL_SHORT = { es: '小学', jhs: '中学', hs: '高校', hsp: '高校（専門）' }
/** 日本語のときの科目の名前（src/main/content.ts の courseTitle と同じ組み立て） */
function jaTitle(c) {
  if (/^\d(・\d)? 年$/.test(c.label)) return `${SCHOOL_SHORT[c.school]} ${c.label} ${c.subjectLabel}`
  if (c.school === 'hs') return `高校 ${c.label}`
  if (c.school === 'hsp') return `高校 ${c.subjectLabel}（${c.label}）`
  return c.label === c.subjectLabel ? `${SCHOOL_SHORT[c.school]} ${c.label}` : `${SCHOOL_SHORT[c.school]} ${c.subjectLabel}（${c.label}）`
}
if (has('catalog')) {
  const file = join(content, `catalog.${lang}.json`)
  const out = has('redo') ? { schools: {}, courses: {} } : (readJson(file) ?? { schools: {}, courses: {} })
  out.schools = lang === 'en' ? { es: 'Elementary school', jhs: 'Junior high school', hs: 'High school', hsp: 'High school (specialized courses)' } : out.schools
  const todo = catalog.courses.filter((c) => !out.courses[c.id])
  const batches = []
  for (let i = 0; i < todo.length; i += 12) batches.push(todo.slice(i, i + 12))
  const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, subjectLabel: { type: 'string' }, label: { type: 'string' }, title: { type: 'string' }, scope: { type: 'string' } }, required: ['id', 'subjectLabel', 'label', 'title', 'scope'] } } }, required: ['items'] }
  const system = `${BASE}

You get a list of courses. For each, return:
- subjectLabel: the name of the subject (教科), short, e.g. 数学 → "Math" for elementary/junior high ("算数" → "Math"), "Mathematics" for high school; 国語 → "Japanese"; 理科 → "Science"; 社会 → "Social Studies"; 英語 → "English"; 道徳 → "Moral Education"; 農業 → "Agriculture"; 工業 → "Industry"; 商業 → "Commerce"; 水産 → "Fisheries"; 家庭 → "Home Economics"; 看護 → "Nursing"; 情報 → "Information"; 福祉 → "Welfare"; 理数 → "Science and Mathematics"; 体育 → "Physical Education"; 音楽 → "Music"; 美術 → "Art".
- label: the name of the course within the subject. "1 年" → "Year 1" for junior high, "Grade 1" for elementary; "1・2 年" → "Grades 1–2"; a high school course name such as 数学I → "Mathematics I", 歴史総合 → "Modern and Contemporary History", 公共 → "Public", 言語文化 → "Language Culture"; for specialized courses translate the course name (課題研究 → "Project Study").
- title: the full display name of the course, built like the Japanese title but in natural ${NAME} word order: "Junior High Math, Year 1"; "Elementary Science, Grade 4"; "Elementary Moral Education, Grades 1–2"; "High School: Mathematics I"; "High School Agriculture: Project Study".
- scope: the list of what the course covers, translated as a compact list in the same order.
Keep the id unchanged.`
  await pool(batches, 6, async (batch) => {
    const user = JSON.stringify(batch.map((c) => ({ id: c.id, school: c.school, subjectLabel: c.subjectLabel, label: c.label, japaneseTitle: jaTitle(c), scope: c.scope })), null, 1)
    const answer = await retry(() => ask(system, user, schema), batch[0].id)
    for (const item of answer?.items ?? []) {
      if (!batch.some((c) => c.id === item.id) || !item.title?.trim()) continue
      out.courses[item.id] = { subjectLabel: item.subjectLabel.trim(), label: item.label.trim(), title: item.title.trim(), scope: item.scope.trim() }
    }
    writeJson(file, out)
  })
  // 同じ教科の科目で、教科の名前がそろっているようにする（いちばん多い訳に合わせる）
  const bySubject = new Map()
  for (const c of catalog.courses) {
    const got = out.courses[c.id]?.subjectLabel
    if (!got) continue
    const key = `${c.school === 'hsp' ? 'hsp' : c.school}:${c.subject}`
    if (!bySubject.has(key)) bySubject.set(key, new Map())
    bySubject.get(key).set(got, (bySubject.get(key).get(got) ?? 0) + 1)
  }
  for (const c of catalog.courses) {
    const votes = bySubject.get(`${c.school === 'hsp' ? 'hsp' : c.school}:${c.subject}`)
    if (!votes || !out.courses[c.id]) continue
    out.courses[c.id].subjectLabel = [...votes].sort((a, b) => b[1] - a[1])[0][0]
  }
  writeJson(file, out)
  console.log(`科目表: ${Object.keys(out.courses).length} / ${catalog.courses.length} 科目`)
}

// ───────── 登場人物 ─────────
if (has('characters')) {
  const file = join(content, `characters.${lang}.json`)
  const defaults = readJson(join(content, 'characters.json'))
  const out = has('redo') ? [] : (readJson(file) ?? [])
  const FAMILY = { s01: 'Morino', s02: 'Maruyama', s03: 'Takao', s04: 'Chatani', s05: 'Futaba', s06: 'Akabane', s07: 'Aoba', s08: 'Kurokawa', s09: 'Kurihara', s10: 'Miyoshi', s11: 'Wakaba', s12: 'Kashiwagi', s13: 'Iwase', s14: 'Mugino', s15: 'Natsume', s16: 'Konno', s17: 'Midorikawa', s18: 'Kirishima', s19: 'Sumida', s20: 'Himura' }
  const nameOf = (c) => (c.id === 'sensei' ? TRANSLATION_LANGS[lang].teacher : `${CAST[c.id]} ${FAMILY[c.id]}`)
  const schema = { type: 'object', properties: { summary: { type: 'string' }, persona: { type: 'string' }, speech: { type: 'string' }, expressionHints: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['summary', 'persona', 'speech', 'expressionHints'] }
  const system = `${BASE}

You get the definition of one character of the app (the homeroom teacher, or a classmate) as JSON. The app's AI plays this character when it talks with the student in ${NAME}, so the result is used as instructions for that role-play.
- summary: the one-line introduction shown to the student. Translate it.
- persona: the description of the person. Translate it faithfully (the teacher's full name is Minori Hanaoka; students call her "${TRANSLATION_LANGS[lang].teacher}").
- speech: how the character talks. The original describes Japanese speech (polite forms, first-person words, sentence endings). Do not translate those literally; describe the equivalent way of speaking in ${NAME} that gives the same impression — the level of politeness, warmth, energy, sentence length, typical phrases in ${NAME}, and how the character addresses the student. Keep the rules that are not about the Japanese language (for example "does not decorate sentences with symbols or emoji").
- expressionHints: keep the keys; translate each value (when to use that facial expression).`
  const todo = defaults.filter((c) => !out.some((x) => x.id === c.id))
  await pool(todo, 6, async (c) => {
    const answer = await retry(() => ask(system, JSON.stringify({ name: c.name, role: c.role, summary: c.summary, persona: c.persona, speech: c.speech, expressionHints: c.expressionHints }, null, 1), schema), c.id)
    if (!answer) return
    out.push({ id: c.id, name: nameOf(c), roleLabel: c.role === 'teacher' ? 'teacher' : 'classmate', summary: answer.summary, persona: answer.persona, speech: answer.speech, expressionHints: Object.fromEntries(Object.keys(c.expressionHints).map((key) => [key, answer.expressionHints?.[key] ?? c.expressionHints[key]])) })
    out.sort((a, b) => defaults.findIndex((x) => x.id === a.id) - defaults.findIndex((x) => x.id === b.id))
    writeJson(file, out)
  })
  console.log(`登場人物: ${out.length} / ${defaults.length} 人`)
}

// ───────── 単元表 ─────────
const curriculumSource = (courseId) => {
  const shipped = join(content, courseId, 'curriculum.json')
  return existsSync(shipped) ? { file: shipped, target: join(content, courseId, `curriculum.${lang}.json`) } : { file: join(dataDir, 'curricula', `${courseId}.json`), target: join(outRoot, 'curricula', `${courseId}.json`) }
}
if (has('curricula')) {
  const overlay = readJson(join(content, `catalog.${lang}.json`)) ?? { courses: {} }
  const schema = {
    type: 'object',
    properties: { units: { type: 'array', items: { type: 'object', properties: { domain: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, lessons: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' } }, required: ['title', 'summary'] } } }, required: ['domain', 'title', 'summary', 'lessons'] } } },
    required: ['units'],
  }
  const system = `${BASE}

You get the unit list (curriculum) of one course as JSON: units, each with "domain" (the area of the curriculum it belongs to; may be empty), "title", "summary", and "lessons" (each with "title" and "summary"). Return the same structure — the same number of units and the same number of lessons in each unit, in the same order — with every text translated into ${NAME}. Titles are short noun phrases in title case for units and sentence case for lessons; summaries are one sentence each. Keep an empty "domain" empty.
- When the course teaches the Japanese language (kokugo) or calligraphy, keep Japanese terms that are the object of study (titles of classical works, kana, kanji) with a short ${NAME} gloss.`
  const todo = catalog.courses.map((c) => ({ course: c, ...curriculumSource(c.id) })).filter((x) => existsSync(x.file) && (has('redo') || !existsSync(x.target)))
  console.log(`単元表: これから訳すのは ${todo.length} 科目`)
  await pool(todo, 10, async ({ course, file, target }) => {
    const source = readJson(file)
    if (!source?.units?.length) return
    const user = `Course: ${jaTitle(course)}${overlay.courses?.[course.id]?.title ? ` (${overlay.courses[course.id].title})` : ''}\n\n${JSON.stringify({ units: source.units.map((u) => ({ domain: u.domain ?? '', title: u.title, summary: u.summary, lessons: u.lessons.map((l) => ({ title: l.title, summary: l.summary })) })) })}`
    const answer = await retry(async () => {
      const got = await ask(system, user, schema)
      if (got.units?.length !== source.units.length || got.units.some((u, i) => u.lessons?.length !== source.units[i].lessons.length)) throw new Error('単元や授業の数が元とちがう')
      return got
    }, course.id)
    if (answer) writeJson(target, { units: answer.units.map((u) => ({ domain: u.domain ?? '', title: u.title, summary: u.summary, lessons: u.lessons.map((l) => ({ title: l.title, summary: l.summary })) })) })
  })
  console.log(`単元表: ${catalog.courses.filter((c) => existsSync(curriculumSource(c.id).target)).length} / ${catalog.courses.filter((c) => existsSync(curriculumSource(c.id).file)).length} 科目`)
}

// ───────── 訳した授業の題を、単元表にそろえる ─────────
if (has('titles')) {
  let changed = 0
  for (const course of catalog.courses) {
    const { target } = curriculumSource(course.id)
    const curriculum = readJson(target)
    if (!curriculum) continue
    const shippedDir = join(content, course.id)
    let touched = false
    curriculum.units.forEach((unit, u) =>
      unit.lessons.forEach((lesson, l) => {
        const id = `${course.id}-${u + 1}-${l + 1}`
        const file = existsSync(join(shippedDir, `${id}.${lang}.md`)) ? join(shippedDir, `${id}.${lang}.md`) : join(outRoot, 'lessons', `${id}.md`)
        if (!existsSync(file)) return
        const head = /^# (.+)$/m.exec(readFileSync(file, 'utf8').slice(0, 400))?.[1]?.replace(/^\d+-\d+[ 　]+/, '').trim()
        if (head && head !== lesson.title && head.length <= 120) {
          lesson.title = head
          touched = true
          changed += 1
        }
      }),
    )
    if (touched) writeJson(target, curriculum)
  }
  console.log(`授業の題を本文にそろえました: ${changed} 件`)
}

// ───────── 画像の説明 ─────────
if (has('media')) {
  const manifest = readJson(join(dataDir, 'media', 'media.json'), { pictures: {} })
  const file = join(outRoot, 'media.json')
  const out = has('redo') ? { pictures: {} } : (readJson(file) ?? { pictures: {} })
  const todo = Object.entries(manifest.pictures ?? {}).filter(([id, p]) => p.alt && !out.pictures[id])
  const batches = []
  for (let i = 0; i < todo.length; i += 40) batches.push(todo.slice(i, i + 40))
  const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, text: { type: 'string' } }, required: ['n', 'text'] } } }, required: ['items'] }
  const system = `${BASE}\n\nYou get numbered descriptions of pictures used in lessons (alternative text read aloud to students who cannot see the picture). Translate each into ${NAME}, one item per number.`
  console.log(`画像の説明: これから訳すのは ${todo.length} 点`)
  await pool(batches, 6, async (batch) => {
    const answer = await retry(() => ask(system, batch.map(([, p], i) => `${i + 1}. ${p.alt}`).join('\n'), schema), batch[0][0])
    for (const item of answer?.items ?? []) {
      const entry = batch[item.n - 1]
      if (entry && item.text?.trim()) out.pictures[entry[0]] = item.text.trim()
    }
    writeJson(file, out)
  })
  console.log(`画像の説明: ${Object.keys(out.pictures).length} / ${Object.values(manifest.pictures ?? {}).filter((p) => p.alt).length} 点`)
}

// ───────── 掛け合いに出る人物の名前 ─────────
if (has('names')) {
  const index = readJson(join(outRoot, 'lessons-index.json'), {})
  const votes = new Map()
  for (const record of Object.values(index))
    for (const [ja, name] of Object.entries(record.people ?? {})) {
      if (!votes.has(ja)) votes.set(ja, new Map())
      votes.get(ja).set(name, (votes.get(ja).get(name) ?? 0) + 1)
    }
  // 同じ人の訳が授業によってちがうときは、いちばん多いものにそろえる
  const names = Object.fromEntries([...votes].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ja, counts]) => [ja, [...counts].sort((a, b) => b[1] - a[1])[0][0]]))
  writeJson(join(outRoot, 'people.json'), names)
  const split = [...votes].filter(([, counts]) => counts.size > 1)
  console.log(`人物の名前: ${Object.keys(names).length} 人（訳が分かれていた人 ${split.length} 人${split.length ? `: ${split.slice(0, 8).map(([ja, counts]) => `${ja} → ${[...counts.keys()].join(' / ')}`).join('、')}` : ''}）`)
}
