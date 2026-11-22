// 記述・論述の練習に使う問題と解答例を、授業ごとに、AI にまとめて作らせる。
//
//   node --no-warnings tools/make-essays.mjs [--schools jhs,hs] [--courses 科目,…] [--only 保存名,…] [--limit 件数]
//        [--concurrency 10] [--model haiku] [--effort low] [--redo] [--count] [--five 0.85] [--week 0.98]
//
// - 1 つの授業につき、記述の問題 2 問と、論述の問題 1 問を、解答例・採点の要点つきで作る。
//   指示文・返事の形・確かめは、アプリと同じもの（src/shared/essay.ts）を使う。
// - できたものは <データ置き場>/essay/<保存名>.json に置く（アプリは、記述・論述の練習の画面でこれを読む）。
//   授業の本文は読むだけで、書きかえない。本文の目印（src）が同じものは、作り直さない。
// - 道徳と、学び直し向けの本文は、対象にしない（アプリの中で、開いたときに作れる）。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ESSAY_SCHEMA, cleanEssaySet, essaySystemPrompt, essayUserPrompt } from '../src/shared/essay.ts'
import { askClaude, createLimiter } from './lib/claude.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback)
const has = (name) => args.includes(`--${name}`)
const list = (name) => opt(name, '').split(',').filter(Boolean)
const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const lessonsDir = join(dataDir, 'lessons')
const outDir = join(dataDir, 'essay')
const workDir = join(dataDir, 'ai-workdir')
const tempDir = join(dataDir, 'ai-temp')
for (const dir of [outDir, workDir, tempDir]) mkdirSync(dir, { recursive: true })
const log = (text) => console.log(`${new Date().toLocaleTimeString('ja-JP', { hour12: false })} ${text}`)
const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12)
const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (file, value) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value), 'utf8')
  renameSync(`${file}.tmp`, file)
}
const read = (file) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n')

const catalog = JSON.parse(readFileSync(join(root, 'resources', 'content', 'catalog.json'), 'utf8'))
const SCHOOL_SHORT = { es: '小学', jhs: '中学', hs: '高校', hsp: '高校（専門）', univ: '大学', grad: '大学院' }
function courseTitle(c) {
  if (/^\d(・\d)? 年$/.test(c.label)) return `${SCHOOL_SHORT[c.school]} ${c.label} ${c.subjectLabel}`
  if (c.school === 'hs') return `高校 ${c.label}`
  if (c.school === 'hsp') return `高校 ${c.subjectLabel}（${c.label}）`
  return c.label === c.subjectLabel ? `${SCHOOL_SHORT[c.school]} ${c.label}` : `${SCHOOL_SHORT[c.school]} ${c.subjectLabel}（${c.label}）`
}
const schools = list('schools').length ? list('schools') : ['jhs', 'hs']
const onlyCourses = list('courses')
const onlyKeys = list('only')
const generated = new Set(readdirSync(lessonsDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)))
const targets = []
for (const c of catalog.courses) {
  if (onlyCourses.length ? !onlyCourses.includes(c.id) : !schools.includes(c.school) || c.subject === 'moral') continue
  const shipped = join(root, 'resources', 'content', c.id, 'curriculum.json')
  const curriculum = existsSync(shipped) ? readJson(shipped, null) : readJson(join(dataDir, 'curricula', `${c.id}.json`), null)
  if (!curriculum?.units?.length) continue
  const grade = c.school === 'es' ? Number(c.label.match(/(\d) 年$/)?.[1] ?? 6) : null
  curriculum.units.forEach((unit, u) =>
    unit.lessons.forEach((lesson, l) => {
      const key = `${c.id}-${u + 1}-${l + 1}`
      const authored = join(root, 'resources', 'content', c.id, `${key}.md`)
      const file = existsSync(authored) ? authored : generated.has(key) ? join(lessonsDir, `${key}.md`) : null
      if (!file || (onlyKeys.length && !onlyKeys.includes(key))) return
      targets.push({ key, file, course: c, grade, unitTitle: unit.title, number: `${u + 1}-${l + 1}`, title: lesson.title })
    }),
  )
}
const recordFile = (key) => join(outDir, `${key}.json`)
const todo = targets.filter((t) => has('redo') || readJson(recordFile(t.key), null)?.src !== hash(read(t.file)))
const queue = opt('limit', '') ? todo.slice(0, Number(opt('limit'))) : todo
if (has('count')) {
  console.log(`授業 ${targets.length} 件のうち、作るのは ${queue.length} 件`)
  process.exit(0)
}

const limiter = createLimiter({ five: Number(opt('five', 0.85)), week: Number(opt('week', 0.98)), wait: true, log })
const model = opt('model', 'haiku')
const effort = opt('effort', 'low')
async function make(t) {
  const body = read(t.file)
  const target = { school: t.course.school, courseTitle: courseTitle(t.course), grade: t.grade, unitTitle: t.unitTitle, number: t.number, title: t.title, moral: t.course.subject === 'moral', body }
  const systemFile = join(tempDir, `essay-system-${t.key}.md`)
  writeFileSync(systemFile, essaySystemPrompt(target), 'utf8')
  try {
    const token = await limiter.enter()
    let answer
    try {
      answer = await askClaude({ systemFile, userText: essayUserPrompt(target), model, effort, schema: ESSAY_SCHEMA, cwd: workDir, limiter, timeoutMs: 8 * 60_000 })
    } catch (error) {
      limiter.fail(error?.message)
      throw error
    } finally {
      limiter.leave(token)
    }
    const set = cleanEssaySet(answer.structured ?? JSON.parse(answer.text.replace(/^```(?:json)?\n?|\n?```$/g, '')))
    if (!set.short.length || !set.long.length) throw new Error('問題が足りません')
    writeJson(recordFile(t.key), { src: hash(body), at: Date.now(), ...set })
    return answer.cost
  } finally {
    rmSync(systemFile, { force: true })
  }
}

log(`授業 ${targets.length} 件のうち、${queue.length} 件の問題と解答例を作ります（${model}・${effort}・同時に ${opt('concurrency', 10)} 件）`)
let at = 0
let done = 0
let failed = 0
let cost = 0
await Promise.all(
  Array.from({ length: Math.min(Number(opt('concurrency', 10)), queue.length) }, async () => {
    while (at < queue.length) {
      const t = queue[at++]
      let ok = false
      for (let attempt = 0; attempt < 2 && !ok; attempt += 1) {
        try {
          cost += await make(t)
          done += 1
          ok = true
        } catch (error) {
          if (attempt === 1) {
            failed += 1
            log(`失敗: ${t.key} ${String(error?.message ?? error).slice(0, 160)}`)
          }
        }
      }
      if ((done + failed) % 25 === 0) log(`${done} / ${queue.length} 件（失敗 ${failed}）料金（API 換算）${cost.toFixed(2)} ドル`)
    }
  }),
)
log(`終わりました。${done} 件（失敗 ${failed}）。料金（API 換算）${cost.toFixed(2)} ドル`)
