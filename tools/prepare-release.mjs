// 公開するものを、手もとで用意する（外へは、何も送らない）。
//
//   node --no-warnings tools/prepare-release.mjs            全部（Web 版を作る → 教材を書き出す → 表示の文書 → 確かめ）
//   node --no-warnings tools/prepare-release.mjs --check    いま書き出してあるものを、確かめるだけ
//
// できるもの:
//   release/site/dist/           … Web 版（Cloudflare などに、そのまま置けるサイト。教材は、公開する科目だけ）
//   release/site/dist/data/      … 教材。Windows 版のインストーラーにも、これを入れる（package.json の build.extraResources）
//   THIRD_PARTY_NOTICES.md       … 第三者の素材と部品の表示
// このあと、インストーラーを作るときは: npm run build && npm run dist（release/win/ にできる）
//
// 確かめること: ファイルの数（Cloudflare の有料プランは 1 サイト 100,000 個まで）、1 個の大きさ（25 MiB まで）、
// 大学・大学院の教材が入っていないこと、この PC の利用者の名前が入った道すじが書かれていないこと。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'release', 'site', 'dist')
const checkOnly = process.argv.includes('--check')
const run = (label, command, args, env = {}) => {
  console.log(`\n── ${label}`)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } })
  if (result.status !== 0) throw new Error(`${label} で止まりました`)
}

if (!checkOnly) {
  // 配る版の Web 版は、AI のつなぎ方が「自分の API キー」だけ（MANABI_WEB_ROUTES を消して作る）
  run('Web 版を作る', 'npm', ['run', 'web:build'], { MANABI_WEB_ROUTES: '' })
  run('教材を書き出す（公開する科目のすべて）', 'node', ['--no-warnings', 'tools/export-site.mjs', '--courses', 'public', '--out', 'release/site'])
  run('第三者の素材と部品の表示を作る', 'node', ['--no-warnings', 'tools/build-notices.mjs'])
}
if (!existsSync(join(dist, 'index.html'))) throw new Error('release/site/dist がありません。--check をつけずに動かしてください。')

// ───────── 確かめ ─────────
const LIMIT_FILES = 100_000
const LIMIT_BYTES = 25 * 1024 * 1024
const me = basename(homedir())
const stats = { files: 0, bytes: 0, big: [], hidden: [], personal: [] }
const byTop = {}
const walk = (dir, top = '') => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const group = top || entry.name
    if (entry.isDirectory()) {
      walk(full, top ? top : entry.name === 'data' ? '' : entry.name)
      continue
    }
    const size = statSync(full).size
    stats.files += 1
    stats.bytes += size
    const key = full.slice(dist.length + 1).split(/[\\/]/).slice(0, 2).join('/')
    byTop[key] = byTop[key] ?? { files: 0, bytes: 0 }
    byTop[key].files += 1
    byTop[key].bytes += size
    if (size > LIMIT_BYTES) stats.big.push(`${full.slice(dist.length + 1)}（${Math.round(size / 1024 / 1024)} MB）`)
    if (/^(univ|grad)\d*-/.test(entry.name)) stats.hidden.push(full.slice(dist.length + 1))
    // 文章のファイルに、この PC の利用者の名前が入った道すじが残っていないか
    if (me && /\.(md|json|js|html|css|txt)$/.test(entry.name) && size < 8 * 1024 * 1024 && readFileSync(full, 'utf8').includes(`Users\\${me}`)) stats.personal.push(full.slice(dist.length + 1))
    void group
  }
}
walk(dist)

// 教材の版（Windows 版が、はじめて開いたときに取りこむかどうかを決める印）
// builtAt: これよりあとに利用者が書きかえたファイルは、取りこみで置きかえない（src/main/pack.ts）
const pack = { version: new Date().toISOString().slice(0, 16), builtAt: Date.now(), files: stats.files }
if (!checkOnly || !existsSync(join(dist, 'data', 'pack.json'))) writeFileSync(join(dist, 'data', 'pack.json'), JSON.stringify(pack), 'utf8')

// 単元表にある授業の本文が、そろっているか（単元表と本文の版が食いちがうと、ここで欠ける）
const lacking = []
{
  const curricula = join(dist, 'data', 'curricula')
  for (const name of readdirSync(curricula).filter((n) => n.endsWith('.json') && n !== '_list.json')) {
    const id = name.slice(0, -5)
    const units = JSON.parse(readFileSync(join(curricula, name), 'utf8')).units ?? []
    let missing = 0
    let total = 0
    units.forEach((unit, i) =>
      (unit.lessons ?? []).forEach((_lesson, j) => {
        total += 1
        const key = `${id}-${i + 1}-${j + 1}.md`
        if (!existsSync(join(dist, 'data', 'lessons', key)) && !existsSync(join(dist, 'res', 'content', id, key))) missing += 1
      }),
    )
    if (missing) lacking.push(`${id}（${missing} / ${total}）`)
  }
}

// Claude の中で作った教材で、まだ「本当の置き場」に取りこんでいないものがあるか。
// あると、この道具を Claude の外（ふつうのターミナル）で動かしたときに、古い教材を書き出してしまう
let unsynced = ''
{
  const result = spawnSync(process.execPath, ['--no-warnings', join(root, 'tools', 'sync-data.mjs')], { encoding: 'utf8' })
  const found = /新しく入れる\s+(\d+)\s+新しいもので上書き\s+(\d+)/g
  let added = 0
  let updated = 0
  for (const m of String(result.stdout ?? '').matchAll(found)) {
    added += Number(m[1])
    updated += Number(m[2])
  }
  if (added + updated > 0) unsynced = `まだ取りこんでいない教材があります（新しいもの ${added} 個・書きかわったもの ${updated} 個）。「教材を取りこむ」を済ませてから、もう一度動かしてください`
}

console.log('\n── 確かめ')
for (const [key, value] of Object.entries(byTop).sort((a, b) => b[1].files - a[1].files).slice(0, 12)) console.log(`  ${key.padEnd(28)} ${String(value.files).padStart(7)} 個  ${String(Math.round(value.bytes / 1024 / 1024)).padStart(5)} MB`)
console.log(`  合計 ${stats.files.toLocaleString()} 個・${Math.round(stats.bytes / 1024 / 1024).toLocaleString()} MB`)
const problems = []
if (stats.files > LIMIT_FILES) problems.push(`ファイルが ${stats.files.toLocaleString()} 個あります（Cloudflare の有料プランの上限は 100,000 個）`)
if (stats.big.length) problems.push(`25 MiB をこえるファイルがあります: ${stats.big.slice(0, 5).join('、')}`)
if (stats.hidden.length) problems.push(`大学・大学院の教材が入っています（${stats.hidden.length} 個。例: ${stats.hidden[0]}）`)
if (lacking.length) problems.push(`単元表にある授業の本文が、欠けている科目があります: ${lacking.slice(0, 8).join('、')}`)
if (unsynced) problems.push(unsynced)
if (stats.personal.length) problems.push(`この PC の利用者の名前が入った道すじが書かれています（${stats.personal.length} 個。例: ${stats.personal[0]}）`)
if (problems.length) {
  console.log(`\n直すところ:\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log('\n問題は見つかりませんでした。')
