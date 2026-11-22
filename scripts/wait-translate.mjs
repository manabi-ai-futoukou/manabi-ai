// まとめて訳す道具（tools/translate-lessons.mjs）が終わるのを待つ。終わったら、結果を 1 行で出して終わる。
//
//   node scripts/wait-translate.mjs [--lang en] [--pid 道具のプロセス番号] [--pause]
//
// 進み具合は <データ置き場>/i18n/<言語>/progress.json を見る。--pid を付けると、道具が途中で止まったときにも気づける。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => (args.indexOf(`--${name}`) >= 0 ? args[args.indexOf(`--${name}`) + 1] : fallback)
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const file = join(dataDir, 'i18n', opt('lang', 'en'), 'progress.json')
const pid = Number(opt('pid', 0))
const pauseToo = args.includes('--pause')
const since = Date.now()
const alive = () => {
  if (!pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const read = () => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
for (;;) {
  const p = read()
  if (p?.state === '終わり') {
    console.log(`終わりました: 訳した ${p.done} 件、訳せなかった ${p.failed} 件、訳し直し ${p.retried} 件、${p.minutes} 分、5 時間 ${p.five}・週 ${p.week}`)
    break
  }
  // --pause を付けると、使用量の目安に届いて休みに入ったときにも知らせる（待ちはじめる前の古い記録は見ない）
  if (pauseToo && p?.state === '休み' && Date.parse(p.at) >= since) {
    console.log(`休みに入りました: ${p.pauseWhy}。${p.pauseUntil ? new Date(p.pauseUntil).toLocaleString('ja-JP') : '?'} まで。今回 訳した ${p.done} 件、訳せなかった ${p.failed} 件、訳し直し ${p.retried} 件（今回の対象 ${p.total} 件）、${p.minutes} 分、5 時間 ${p.five}・週 ${p.week}`)
    break
  }
  if (!alive()) {
    console.log(`道具が止まっています（最後の記録: ${p ? `${p.state}、${p.done + p.failed} / ${p.total} 件、5 時間 ${p.five}・週 ${p.week}、${p.at}` : 'なし'}）`)
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 60_000))
}
