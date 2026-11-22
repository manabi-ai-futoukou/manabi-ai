// 通しの読み直し（tools/review-pipeline.mjs）が終わるか、止まるのを待つ。終わったら、結果を 1 行で出して終わる。
//
//   node scripts/wait-pipeline.mjs [--lang en] [--pid 道具のプロセス番号]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => (args.indexOf(`--${name}`) >= 0 ? args[args.indexOf(`--${name}`) + 1] : fallback)
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const dir = join(dataDir, 'i18n', opt('lang', 'en'))
const pid = Number(opt('pid', 0))
const read = (name) => {
  try {
    return JSON.parse(readFileSync(join(dir, name), 'utf8'))
  } catch {
    return null
  }
}
const alive = () => {
  if (!pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
for (;;) {
  const p = read('pipeline.json')
  const where = p ? `${p.step} / ${p.of}「${p.name}」` : '記録なし'
  if (p?.state === '終わり') {
    console.log(`すべて終わりました（${p.at}）`)
    break
  }
  if (p?.state === '失敗') {
    console.log(`途中の段が失敗しました: ${where}`)
    break
  }
  if (!alive()) {
    const r = read('review-progress.json')
    console.log(`道具が止まっています（最後の記録: ${where}。読み直しは ${r ? `${r.done} / ${r.total} 件、${r.state}` : '記録なし'}）`)
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 60_000))
}
