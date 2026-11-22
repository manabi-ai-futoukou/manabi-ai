// 作った絵・取り寄せた資料画像（assets-src/media/）を、アプリのデータ置き場に入れる。
//
//   node scripts/install-media.mjs                入れられるものを、すべて入れる
//   node scripts/install-media.mjs --people       人物の絵だけ（授業の本文には触れないので、アプリを開いたままでも実行できる）
//   node scripts/install-media.mjs --scenes       挿絵だけ
//   node scripts/install-media.mjs --materials    資料画像（公開されている肖像画・写真など）だけ
//   node scripts/install-media.mjs --remove       入れたものを取りのぞき、本文を元にもどす（上の指定と組み合わせられる）
//
// 画像は <データ置き場>/media/ に、何の絵か・出どころは media/media.json に書く（アプリは、この一覧を見て表示する）。
// 挿絵と資料画像は、指定された節の終わりに差しこむ（本文そのものは書きかえない）。確認で問題が残った絵（check.json の ok が false）は入れない。
// 挿絵と資料画像を入れるときは、アプリが授業を書きかえていないとき（教材づくりが止まっているか、アプリを閉じているとき）に実行する。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { formatPicture, insertAfterSection } from '../src/shared/blocks.ts'

const flags = process.argv.slice(2)
const remove = flags.includes('--remove')
const only = ['--people', '--scenes', '--materials'].filter((f) => flags.includes(f))
const wants = (kind) => !only.length || only.includes(`--${kind}`)
const root = resolve(import.meta.dirname, '..')
const source = join(root, 'assets-src', 'media')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
const mediaDir = join(dataDir, 'media')
mkdirSync(mediaDir, { recursive: true })
const manifestFile = join(mediaDir, 'media.json')
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {}
manifest.pictures ??= {}
manifest.people ??= {}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
}
const list = (dir, ext) => (existsSync(join(source, dir)) ? readdirSync(join(source, dir)).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length)) : [])
const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 10)
function convert(mode, from, to) {
  const run = spawnSync('python', [join(root, 'tools', 'convert_media.py'), mode, from, to], { encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`画像を変換できませんでした: ${from}\n${run.stderr}`)
}
/** 本文から、その id の挿絵のブロックだけを取りのぞく */
const withoutPicture = (body, id) => body.replace(/\r\n/g, '\n').replace(new RegExp('^```picture\\n[^\\n]*"id":"' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^\\n]*\\n```\\n\\n?', 'gm'), '')
const lessonFile = (key) => join(dataDir, 'lessons', `${key}.md`)
/** 授業の本文に、挿絵のブロックを入れる（同じ id のものがあれば、入れ直す）。入れられたら true */
function place(key, id, after, caption) {
  const file = lessonFile(key)
  if (!existsSync(file)) return false
  const body = withoutPicture(readFileSync(file, 'utf8'), id)
  const placed = insertAfterSection(body, String(after ?? ''), formatPicture({ id, caption }))
  if (!placed) return false
  writeFileSync(file, placed, 'utf8')
  return true
}
function unplace(key, id) {
  const file = lessonFile(key)
  if (existsSync(file)) writeFileSync(file, withoutPicture(readFileSync(file, 'utf8'), id), 'utf8')
}

// --reviewed-only: 人が目で見たもの（tools/review-list.mjs --mark で assets-src/media/reviewed.json に記録したもの）だけを入れる
const reviewedOnly = flags.includes('--reviewed-only')
const reviewed = readJson(join(source, 'reviewed.json')) ?? {}
const seen = (kind, key) => !reviewedOnly || (reviewed[kind] ?? []).includes(key)
const newer = (target, from) => existsSync(target) && statSync(target).mtimeMs >= statSync(from).mtimeMs

const count = { people: 0, scenes: 0, materials: 0, skipped: 0 }

if (wants('people')) {
  for (const name of list('people', '.png')) {
    const file = `person-${hash(name)}.jpg`
    if (remove) {
      if (manifest.people[name]?.file === file) {
        rmSync(join(mediaDir, file), { force: true })
        delete manifest.people[name]
        count.people += 1
      }
      continue
    }
    if (readJson(join(source, 'people', `${name}.check.json`))?.ok === false) {
      count.skipped += 1
      continue
    }
    if (manifest.people[name]?.file !== file || !existsSync(join(mediaDir, file))) convert('person', join(source, 'people', `${name}.png`), join(mediaDir, file))
    manifest.people[name] = { file, kind: 'generated' }
    count.people += 1
  }
}

if (wants('scenes')) {
  for (const key of list('lessons', '.png')) {
    const file = `${key}.jpg`
    if (remove) {
      if (manifest.pictures[key]) {
        unplace(key, key)
        rmSync(join(mediaDir, file), { force: true })
        delete manifest.pictures[key]
        count.scenes += 1
      }
      continue
    }
    const info = readJson(join(source, 'lessons', `${key}.json`))
    const caption = String(info?.caption ?? '').trim()
    // 確認の結果（check.json）が「問題なし」のものだけを入れる（確認の途中のものも入れない）
    if (!caption || readJson(join(source, 'lessons', `${key}.check.json`))?.ok !== true || !existsSync(lessonFile(key)) || !seen('scenes', key)) {
      count.skipped += 1
      continue
    }
    if (!newer(join(mediaDir, file), join(source, 'lessons', `${key}.png`))) convert('scene', join(source, 'lessons', `${key}.png`), join(mediaDir, file))
    manifest.pictures[key] = { file, kind: 'generated', alt: String(info.alt ?? '').slice(0, 200) }
    if (place(key, key, info.after, caption)) count.scenes += 1
    else console.log(`${key}: 挿絵を置く場所が決まりませんでした（画像だけ入れました）`)
  }
}

if (wants('materials')) {
  const label = (license) => (/public domain|^pd/i.test(license) ? 'パブリックドメイン' : license)
  for (const name of list(join('public', 'items'), '.json')) {
    const item = readJson(join(source, 'public', 'items', `${name}.json`))
    const id = `pd-${name}`
    if (remove) {
      if (manifest.pictures[id]) {
        unplace(item.key, id)
        delete manifest.pictures[id]
        count.materials += 1
      }
      continue
    }
    if (!item || item.status !== '取り寄せた' || !existsSync(item.file) || !existsSync(lessonFile(item.key))) {
      count.skipped += 1
      continue
    }
    // 権利の点検（tools/audit-materials.mjs）を通ったものだけを入れる。前に入れたものが、あとの点検で見送りになったら外す
    if (item.audit?.ok === true && !seen('materials', name)) {
      count.skipped += 1
      continue
    }
    if (item.audit?.ok !== true) {
      if (manifest.pictures[id]) {
        unplace(item.key, id)
        delete manifest.pictures[id]
      }
      if (!item.audit) console.log(`${name}: 権利の点検がまだです（node tools/audit-materials.mjs を先に実行します）`)
      count.skipped += 1
      continue
    }
    // 同じ画像を、いくつもの授業で使うことがある。画像のファイルは 1 つだけ置く
    const file = `pd-${hash(item.source.title)}.jpg`
    if (!existsSync(join(mediaDir, file))) convert('scene', item.file, join(mediaDir, file))
    // 作者名を出すのは、表示が条件のもの（CC BY）と、撮った人が権利を手放したもの（CC0 など）だけ。
    // 古い作品（保護期間が終わっているもの）では、コモンズの「作者」欄に、取りこんだ人の名前や URL が入っていることがあるので出さない
    // （作者が分かるものは、説明文に「○○ 筆」などと書いてある）
    const oldWork = ['作品', '確認'].includes(item.audit.class)
    const artist = oldWork || /unknown|anonymous|不明|作者不詳/i.test(item.source.artist) ? '' : [...new Set(item.source.artist.split(/\s{2,}|, /))].join(' ').slice(0, 60)
    manifest.pictures[id] = {
      file,
      kind: 'public',
      credit: `${artist ? `${artist}／` : ''}Wikimedia Commons（${label(item.source.license)}）`,
      alt: String(item.alt ?? '').slice(0, 200),
      source: item.source.page,
      license: item.source.license,
      basis: item.source.basis,
    }
    if (place(item.key, id, item.after, item.caption)) count.materials += 1
    else console.log(`${name}: 資料を置く場所が決まりませんでした（画像だけ入れました）`)
  }
  if (remove) for (const file of readdirSync(mediaDir).filter((f) => f.startsWith('pd-') && !Object.values(manifest.pictures).some((p) => p.file === f))) rmSync(join(mediaDir, file), { force: true })
}

writeFileSync(`${manifestFile}.tmp`, JSON.stringify(manifest, null, 1), 'utf8')
renameSync(`${manifestFile}.tmp`, manifestFile)
console.log(`${remove ? '取りのぞいたもの' : '入れたもの'}: 人物の絵 ${count.people}、挿絵 ${count.scenes}、資料画像 ${count.materials}${remove ? '' : `（入れなかったもの ${count.skipped}）`}`)
