// 注釈づくりの「つづき」を、順に動かす（1 つが終わったら、次へ）。裏で長く動かすためのもの。
//
//   node --no-warnings tools/annotate-chain.mjs [--wait]（いま動いている注釈づくり（_progress.json）が終わるのを待ってから始める）
//
// 順番:
//   1. 小・中・高の注釈の、残り（annotate-lessons.mjs。作ってあるものは、とばす）
//   2. 読みの点検（check-readings.mjs）→ 索引（build-glossary.mjs）
//   3. 記述・論述の問題（make-essays.mjs。中・高 → 小）
//   4. 高校（専門）・大学の注釈 → 読みの点検 → 索引
// どの道具も、Claude の使用量が 5 時間あたり 85%・週あたり 98% に達したら、回復するまで休む。
// 記録は <データ置き場>/annot/_chain.log。
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const logFile = join(dataDir, 'annot', '_chain.log')
const log = (text) => {
  const line = `${new Date().toLocaleString('ja-JP', { hour12: false })} ${text}`
  console.log(line)
  appendFileSync(logFile, `${line}\n`, 'utf8')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (process.argv.includes('--wait')) {
  log('いま動いている注釈づくりが終わるのを待ちます')
  for (;;) {
    let progress = null
    try {
      progress = JSON.parse(readFileSync(join(dataDir, 'annot', '_progress.json'), 'utf8'))
    } catch {
      // まだ書かれていない
    }
    // 終わった、または 10 分より長く進んでいない（止まった）ら、先へ進む
    if (!progress || progress.finished || Date.now() - progress.at > 10 * 60_000) break
    await sleep(30_000)
  }
}

const STEPS = [
  ['小・中・高の注釈の残り', 'annotate-lessons.mjs', ['--schools', 'es,jhs,hs', '--model', 'haiku', '--effort', 'low', '--concurrency', '40']],
  ['読みの点検', 'check-readings.mjs', []],
  ['索引', 'build-glossary.mjs', []],
  ['記述・論述の問題（中・高）', 'make-essays.mjs', ['--schools', 'jhs,hs', '--model', 'haiku', '--concurrency', '30']],
  ['記述・論述の問題（小）', 'make-essays.mjs', ['--schools', 'es', '--model', 'haiku', '--concurrency', '30']],
  ['高校（専門）・大学の注釈', 'annotate-lessons.mjs', ['--schools', 'hsp,univ,grad', '--model', 'haiku', '--effort', 'low', '--concurrency', '40']],
  ['読みの点検（2 回目）', 'check-readings.mjs', []],
  ['索引（2 回目）', 'build-glossary.mjs', []],
]
for (const [name, tool, args] of STEPS) {
  log(`▶ ${name}`)
  const result = spawnSync(process.execPath, ['--no-warnings', join(root, 'tools', tool), ...args], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  const tail = String(result.stdout ?? '').trim().split('\n').slice(-2).join(' ｜ ')
  log(`${result.status === 0 ? '✓' : '✗'} ${name}: ${tail.slice(0, 400)}${result.status === 0 ? '' : ` ${String(result.stderr ?? '').slice(-300)}`}`)
}
log('すべて終わりました')
