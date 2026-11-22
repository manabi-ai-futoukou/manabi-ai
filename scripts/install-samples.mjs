// scripts/try-talk.mjs・try-sim.mjs で試しに作った掛け合い・動く図解を、ふだんのデータに入れる
// （見本として、実際のアプリで読めるようにする）。
//
//   node scripts/install-samples.mjs talk            .try/talk にある掛け合いを、すべて入れる
//   node scripts/install-samples.mjs sim             .try/sim にある動く図解を、すべて入れる
//   node scripts/install-samples.mjs talk --remove   入れたものを取りのぞいて、元の本文にもどす（sim も同じ）
//
// かならず、アプリを閉じてから実行する（アプリは、授業の記録をメモリに持っていて、あとから上書きするため）。
// 本文が試作のときから変わっている授業は、入れずに飛ばす。
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const kind = process.argv[2]
if (kind !== 'talk' && kind !== 'sim') throw new Error('talk か sim を指定してください。')
const remove = process.argv.includes('--remove')
const root = resolve(import.meta.dirname, '..')
const tryDir = resolve(root, process.env['MANABI_TRY_DIR'] ?? `.try/${kind}`)
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const indexFile = join(dataDir, 'lessons-index.json')
const label = kind === 'talk' ? '掛け合い' : '動く図解'

const block = new RegExp('^```' + kind + '\\n[\\s\\S]*?\\n```\\n\\n?', 'gm')
const strip = (body) => body.replace(/\r\n/g, '\n').replace(block, '')
const plain = (body) => strip(body).replace(/^# \d+-\d+[ 　]+/, '# ').trim()

const index = JSON.parse(readFileSync(indexFile, 'utf8'))
const keys = readdirSync(tryDir).filter((f) => f.endsWith('.md') && f !== 'talks.md' && f !== 'sims.md').map((f) => f.slice(0, -3))
let done = 0
for (const key of keys) {
  const target = join(dataDir, 'lessons', `${key}.md`)
  if (!existsSync(target)) {
    console.log(`${key}: ふだんのデータに、この授業がありません`)
    continue
  }
  const current = readFileSync(target, 'utf8')
  if (remove) {
    if (!new RegExp('^```' + kind + '$', 'm').test(current)) continue
    writeFileSync(target, strip(current), 'utf8')
    if (index[key]) delete index[key][kind]
  } else {
    const sample = readFileSync(join(tryDir, `${key}.md`), 'utf8')
    if (plain(sample) !== plain(current)) {
      console.log(`${key}: 本文が試作のときから変わっているので、入れません`)
      continue
    }
    writeFileSync(target, sample, 'utf8')
    index[key] = { ...(index[key] ?? { at: Date.now(), reviewed: false }), [kind]: Date.now() }
  }
  done += 1
}
// 一時ファイルに書いてから置き換える（途中で止まっても、元の記録がこわれない）
writeFileSync(`${indexFile}.tmp`, JSON.stringify(index), 'utf8')
renameSync(`${indexFile}.tmp`, indexFile)
console.log(`${done} 件の授業${remove ? `から、${label}を取りのぞきました` : `に、${label}を入れました`}。`)
