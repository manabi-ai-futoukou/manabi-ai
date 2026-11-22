// 教材づくり（掛け合い・動く図解）が終わるか、止まる（休んでいる・失敗している）まで待って、そのときの数を表示する。
//   node scripts/wait-library.mjs [止まったとみなす分数（はじめは 6）]
// 記録（lessons-index.json）の数が、決めた時間のあいだ変わらなければ、終わったか止まったとみなす。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const data = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const quietMinutes = Number(process.argv[2] ?? 6)
const counts = () => {
  try {
    const index = Object.values(JSON.parse(readFileSync(join(data, 'lessons-index.json'), 'utf8')))
    return { lessons: index.length, talk: index.filter((r) => r.talk).length, sim: index.filter((r) => r.sim).length, simAdded: index.filter((r) => r.sim > 0).length }
  } catch {
    return null // 書きこみの途中で読んだときは、次の回に読み直す
  }
}
let last = ''
let changedAt = Date.now()
for (;;) {
  const now = counts()
  if (now) {
    const text = JSON.stringify(now)
    if (text !== last) {
      last = text
      changedAt = Date.now()
    } else if (Date.now() - changedAt > quietMinutes * 60000) {
      console.log(new Date().toLocaleTimeString('ja-JP'), `${quietMinutes} 分のあいだ変化なし:`, text)
      break
    }
  }
  await new Promise((r) => setTimeout(r, 30000))
}
