// できあがっている授業に、動く図解を試しに足してみる（AI が、合う図解を選べているかの確認用）。
//
//   npm run build && node scripts/try-sim.mjs <授業の ID> [<授業の ID> …]
//
// ふだんのデータは書きかえない。指定した授業と単元表を .try/sim/data に写して、そちらに足す。
// 図解を足した本文は .try/sim/<ID>.md に、選ばれた図解の一覧は .try/sim/sims.md に書き出す。
import electronPath from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const keys = process.argv.slice(2)
if (!keys.length) throw new Error('授業の ID を指定してください。')
const root = resolve(import.meta.dirname, '..')
const outDir = resolve(root, process.env['MANABI_TRY_DIR'] ?? '.try/sim')
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
      .evaluate(([lessonId, variant]) => window.manabi.content.sim(lessonId, variant), [id, deep ? 'deep' : 'standard'])
      .then((result) => ({ key, ...result, seconds: Math.round((Date.now() - began) / 1000) }))
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
  const title = `${lesson.courseTitle} ${lesson.number} ${lesson.title}`
  if (!result.added) {
    console.log(`${result.key}（${title}）: 合う図解なし、${result.seconds} 秒`)
    digest.push(`- ${title}（${result.key}）: 合う図解なし`)
    continue
  }
  writeFileSync(join(outDir, `${result.key}.md`), lesson.body)
  const before = readFileSync(join(source, 'lessons', `${result.key}.md`), 'utf8')
  const spec = JSON.parse(/^```sim\n([\s\S]*?)\n```/m.exec(lesson.body)[1])
  const lines = lesson.body.split('\n')
  const at = lines.indexOf('```sim')
  const section = lines.slice(0, at).reverse().find((l) => l.startsWith('## ')) ?? ''
  const same = lesson.body.replace(/^```sim\n[\s\S]*?\n```\n\n?/gm, '').trim() === before.replace(/\r\n/g, '\n').replace(/^# \d+-\d+[ 　]+/, '# ').trim()
  console.log(`${result.key}（${title}）: ${spec.kind}、${result.seconds} 秒、本文は${same ? '元のまま' : '【変わっている】'}`)
  digest.push(`- ${title}（${result.key}）: **${spec.kind}** ${JSON.stringify({ ...spec, kind: undefined, task: undefined })}\n  - 置き場所: ${section.replace(/^## /, '')}\n  - 課題: ${spec.task}`)
}
writeFileSync(join(outDir, 'sims.md'), digest.join('\n') + '\n')
console.log(`書き出し先: ${outDir}`)
