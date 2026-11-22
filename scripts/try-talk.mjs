// できあがっている授業に、掛け合いを試しに足してみる（出来ばえの確認用）。
//
//   npm run build && node scripts/try-talk.mjs <授業の ID> [<授業の ID> …]
//   例: node scripts/try-talk.mjs jhs-history-3-2 es1-japanese-1-1 es4-math-2-1.deep   （「.deep」は、小学校の学び直し向け）
//
// ふだんのデータは書きかえない。指定した授業と単元表を .try/talk/data に写して、そちらに足す。
// 掛け合いを足した本文は .try/talk/<ID>.md に、掛け合いだけを並べたものは .try/talk/talks.md に書き出す。
import electronPath from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const keys = process.argv.slice(2)
if (!keys.length) throw new Error('授業の ID を指定してください。')
const root = resolve(import.meta.dirname, '..')
const outDir = resolve(root, process.env['MANABI_TRY_DIR'] ?? '.try/talk')
const source = process.env['MANABI_SOURCE_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(outDir, 'data', 'lessons'), { recursive: true })
cpSync(join(source, 'curricula'), join(outDir, 'data', 'curricula'), { recursive: true })
for (const key of keys) {
  const file = join(source, 'lessons', `${key}.md`)
  if (!existsSync(file)) throw new Error(`${key}: 授業の本文がありません（${file}）`)
  cpSync(file, join(outDir, 'data', 'lessons', `${key}.md`))
}

const app = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, MANABI_DATA_DIR: join(outDir, 'data') } })
const home = await app.firstWindow()
await home.waitForSelector('.home')
const began = Date.now()
const results = await Promise.all(
  keys.map((key) => {
    const deep = key.endsWith('.deep')
    const id = deep ? key.slice(0, -5) : key
    return home
      .evaluate(([lessonId, variant]) => window.manabi.content.talk(lessonId, variant), [id, deep ? 'deep' : 'standard'])
      .then((lesson) => ({ key, lesson, seconds: Math.round((Date.now() - began) / 1000) }))
      .catch((error) => ({ key, error: String(error).slice(0, 300) }))
  }),
)
await app.close().catch(() => {})

const digest = []
for (const result of results) {
  if (result.error) {
    console.log(`${result.key}: 失敗 ${result.error}`)
    process.exitCode = 1
    continue
  }
  const { lesson } = result
  writeFileSync(join(outDir, `${result.key}.md`), lesson.body)
  const before = readFileSync(join(source, 'lessons', `${result.key}.md`), 'utf8')
  const blocks = [...lesson.body.matchAll(/^```talk\n([\s\S]*?)\n```/gm)].map((m) => m[1])
  // 掛け合いを取りのぞくと、元の本文と同じになるか（本文に手が入っていないことの確認）
  const stripped = lesson.body.replace(/^```talk\n[\s\S]*?\n```\n\n?/gm, '')
  const same = stripped.trim() === before.replace(/\r\n/g, '\n').replace(/^# \d+-\d+[ 　]+/, '# ').trim()
  console.log(`${result.key}: 掛け合い ${blocks.length} か所、${result.seconds} 秒、本文は${same ? '元のまま' : '【変わっている】'}`)
  digest.push(`## ${lesson.courseTitle} ${lesson.number} ${lesson.title}（${result.key}）\n\n${blocks.map((b, i) => `**${i === 0 ? '導入' : '確かめ問題の前'}**\n\n${b.split('\n').map((l) => `- ${l}`).join('\n')}`).join('\n\n')}\n`)
}
writeFileSync(join(outDir, 'talks.md'), digest.join('\n'))
console.log(`書き出し先: ${outDir}`)
