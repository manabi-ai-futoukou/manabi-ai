// Claude のアプリの中から作った教材を、ふだんのアプリが見ているデータ置き場へ取りこむ。
//
//   node --no-warnings tools/sync-data.mjs            くらべるだけ（何も書かない）
//   node --no-warnings tools/sync-data.mjs --apply    取りこむ（アプリが開いているあいだは、取りこまない）
//
// わけ: Claude のデスクトップアプリは、Windows の「アプリごとの入れもの」（MSIX）の中で動く。その中のプログラム
// （Claude が動かす道具: 授業の掘り下げ・翻訳・挿絵・注釈づくりなど）が %APPDATA% に書いたファイルは、Windows が自動で
//   %LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\
// という「Claude 専用の写しの置き場」に回す。Claude の中からは、本当の置き場と重ねて見えるので気づかないが、
// ふだんのアプリ（学びアイを起動.cmd で開くもの）や、自分で起動した Web 版のサーバーからは、写しの置き場の中身は見えない。
//
// この道具は、写しの置き場にある教材（授業・単元表・注釈・記述と論述の問題・訳・挿絵・動画）を、本当の置き場へ写す。
// - 同じファイルが両方にあるときは、新しいほう（更新時刻で決める）を残す。本当の置き場のほうが新しければ、さわらない
// - 上書きする前のファイルは、<本当の置き場>/backup-before-sync/<日時>/ に残す
// - 授業の記録（lessons-index.json）は、授業ごとに、新しいほうの記録を残す形でまとめる
// - ノート・会話・成績・設定など、利用者のデータは写さない（本当の置き場のものが正しい）
// Claude の中から動かすときは、本当の置き場に \\localhost\C$\… の道すじで書く（この道すじは、写しの置き場に回されない）。
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const apply = process.argv.includes('--apply')
const local = process.env['LOCALAPPDATA'] ?? ''
const roaming = process.env['APPDATA'] ?? ''
/** 写しの置き場（Claude のアプリの入れものの中） */
const packages = join(local, 'Packages')
const pkg = existsSync(packages) ? readdirSync(packages).find((name) => /^Claude_/.test(name) && existsSync(join(packages, name, 'LocalCache', 'Roaming', '学びアイ', 'data'))) : undefined
if (!pkg) {
  console.log('Claude 専用の写しの置き場に、学びアイのデータはありません。取りこむものは、ありません。')
  process.exit(0)
}
const from = join(packages, pkg, 'LocalCache', 'Roaming', '学びアイ', 'data')
/** 本当の置き場。Claude の中から動かしていても、写しの置き場に回されない道すじで開く */
const drive = roaming.slice(0, 1)
const real = `\\\\localhost\\${drive}$${roaming.slice(2)}\\学びアイ\\data`
const to = existsSync(real) ? real : join(roaming, '学びアイ', 'data')
if (!existsSync(to)) {
  console.log(`本当のデータ置き場が見つかりません: ${to}`)
  process.exit(1)
}
console.log(`写しの置き場: ${from}\n本当の置き場: ${to}\n`)

function appOpen() {
  const script = "(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'electron.exe' -or $_.Name -eq '学びアイ.exe') -and ($_.ExecutablePath -like '*学びアイ*' -or $_.CommandLine -like '*学びアイ*') } | Measure-Object).Count"
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
  return !(result.status === 0 && Number(String(result.stdout ?? '').trim()) === 0)
}
if (apply && appOpen()) {
  console.log('学びアイのアプリが開いています。アプリを閉じてから、もう一度動かしてください（開いているあいだは、授業のファイルを書きかえません）。')
  process.exit(2)
}

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
const backupDir = join(to, 'backup-before-sync', stamp)
const walk = (dir, base = '') => {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel))
    else if (!entry.name.endsWith('.tmp')) out.push(rel)
  }
  return out
}

/** 教材のフォルダ（中身をまるごと取りこむ） */
const DIRS = ['lessons', 'curricula', 'annot', 'essay', 'i18n', 'media', 'videos']
/** 教材にかかわる、1 つだけのファイル */
const FILES = ['deepened.json']
const sum = { added: 0, updated: 0, same: 0, realNewer: 0, bytes: 0 }
const byDir = {}
function copy(rel) {
  const src = join(from, rel)
  const dst = join(to, rel)
  const s = statSync(src)
  const top = rel.split('/')[0]
  byDir[top] ??= { added: 0, updated: 0, same: 0, realNewer: 0 }
  let kind
  if (!existsSync(dst)) kind = 'added'
  else {
    const d = statSync(dst)
    // 大きさと更新時刻が同じなら、同じもの。本当の置き場のほうが新しければ、さわらない
    kind = d.size === s.size && Math.abs(d.mtimeMs - s.mtimeMs) < 2000 ? 'same' : d.mtimeMs > s.mtimeMs + 2000 ? 'realNewer' : 'updated'
  }
  sum[kind] += 1
  byDir[top][kind] += 1
  if (kind === 'same' || kind === 'realNewer' || !apply) return
  if (kind === 'updated') {
    mkdirSync(dirname(join(backupDir, rel)), { recursive: true })
    copyFileSync(dst, join(backupDir, rel))
  }
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, `${dst}.sync-tmp`)
  utimesSync(`${dst}.sync-tmp`, s.atime, s.mtime)
  renameSync(`${dst}.sync-tmp`, dst)
  sum.bytes += s.size
}
for (const dir of DIRS) if (existsSync(join(from, dir))) for (const rel of walk(join(from, dir), dir)) copy(rel)
for (const file of FILES) if (existsSync(join(from, file))) copy(file)

// 授業の記録（保存名 → 作った時刻・点検したか・掛け合い・図解）は、授業ごとに、新しいほうを残す
const indexName = 'lessons-index.json'
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}
let merged = 0
if (existsSync(join(from, indexName))) {
  const mine = readJson(join(from, indexName))
  const theirs = readJson(join(to, indexName))
  const out = { ...theirs }
  for (const [key, entry] of Object.entries(mine)) {
    const other = theirs[key]
    const newest = (x) => Math.max(Number(x?.at) || 0, Number(x?.talk) || 0, Number(x?.sim) || 0)
    if (!other || newest(entry) > newest(other)) {
      out[key] = entry
      merged += 1
    }
  }
  if (apply && merged) {
    if (existsSync(join(to, indexName))) {
      mkdirSync(backupDir, { recursive: true })
      copyFileSync(join(to, indexName), join(backupDir, indexName))
    }
    writeFileSync(join(to, `${indexName}.sync-tmp`), JSON.stringify(out), 'utf8')
    renameSync(join(to, `${indexName}.sync-tmp`), join(to, indexName))
  }
}

for (const [dir, n] of Object.entries(byDir)) console.log(`${dir.padEnd(14)} 新しく入れる ${String(n.added).padStart(6)}  新しいもので上書き ${String(n.updated).padStart(5)}  同じ ${String(n.same).padStart(6)}  本当の置き場のほうが新しい ${String(n.realNewer).padStart(4)}`)
console.log(`授業の記録（${indexName}）: ${merged} 件を、新しい記録にする`)
console.log(apply ? `\n取りこみました: 新しく入れた ${sum.added} 個・上書きした ${sum.updated} 個（${(sum.bytes / 1024 / 1024).toFixed(0)} MB）。上書きする前のファイルは ${backupDir}` : `\n（くらべただけで、書いていません。取りこむには --apply を付けます）`)
