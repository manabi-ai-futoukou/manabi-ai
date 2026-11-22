// 科目を 1 つ選んで、単元表と授業 1 回ぶんを AI に試しに作らせる（新しい教科を足したときの、出来ばえの確認用）。
//
//   npm run build && node scripts/try-course.mjs <科目の ID> [<科目の ID> …]
//   例: node scripts/try-course.mjs jhs-dotoku es34-taiiku
//       node scripts/try-course.mjs hsp-fukushi-seikatsu-shien=移乗   （「=言葉」を付けると、名前や内容にその言葉をふくむ授業を選ぶ）
//
// ふだんのデータには触れず、.try/ 以下に作る。単元表は <ID>.curriculum.txt、授業は <ID>.lesson.md に書き出す。
import electronPath from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const ids = process.argv.slice(2)
if (!ids.length) throw new Error('科目の ID を指定してください。')
const root = resolve(import.meta.dirname, '..')
// いくつかを同時に走らせるときは、書き出し先を変える（例: MANABI_TRY_DIR=.try/a）
const outDir = resolve(root, process.env['MANABI_TRY_DIR'] ?? '.try')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(outDir, 'data'), { recursive: true })

const app = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, MANABI_DATA_DIR: join(outDir, 'data') } })
const home = await app.firstWindow()
await home.waitForSelector('.home')
try {
  for (const arg of ids) {
    const [id, keyword] = arg.split('=')
    let began = Date.now()
    const curriculum = await home.evaluate((courseId) => window.manabi.content.ensureCurriculum(courseId), id)
    if (!curriculum) throw new Error(`${id}: 単元表を作れませんでした`)
    const lessons = curriculum.units.flatMap((u) => u.lessons)
    const outline = curriculum.units.map((u) => `${u.number}. ${u.title}${u.domain ? `（${u.domain}）` : ''} — ${u.summary}\n${u.lessons.map((l) => `   ${l.number} ${l.title}: ${l.summary}`).join('\n')}`).join('\n')
    writeFileSync(join(outDir, `${id}.curriculum.txt`), `${curriculum.title}（単元 ${curriculum.units.length}、授業 ${lessons.length} 回）\n\n${outline}\n`)
    console.log(`${curriculum.title}: 単元 ${curriculum.units.length}、授業 ${lessons.length} 回（${Math.round((Date.now() - began) / 1000)} 秒）`)
    // まん中あたりの授業を 1 回ぶん作る（最初の授業は導入で、教科の特徴が出にくいため）
    const lesson = (keyword && lessons.find((l) => `${l.title} ${l.summary}`.includes(keyword))) || lessons[Math.min(lessons.length - 1, 2)]
    began = Date.now()
    const made = await home.evaluate((lessonId) => window.manabi.content.generate(lessonId), lesson.id)
    writeFileSync(join(outDir, `${id}.lesson.md`), made.body)
    console.log(`  ${lesson.number} ${lesson.title}: ${made.body.length} 字、点検 ${made.reviewed ? '済み' : 'なし'}（${Math.round((Date.now() - began) / 1000)} 秒）`)
  }
} catch (error) {
  console.log('失敗:', String(error).slice(0, 400))
  process.exitCode = 1
} finally {
  await app.close().catch(() => {})
}
console.log(`書き出し先: ${outDir}`)
