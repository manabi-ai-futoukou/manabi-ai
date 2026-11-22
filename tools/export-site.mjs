// Web 版と、選んだ科目の教材を、「ファイルを置くだけで動くサイト」のフォルダに書き出す（ChatGPT Sites の静的なサイトなど）。
//
//   node --no-warnings tools/export-site.mjs --courses jhs2-math,hs-nihonshi [--out ../sites-trial] [--no-en] [--dry]
//   node --no-warnings tools/export-site.mjs --courses public --out release/site     公開する科目のすべて（大学・大学院を除く）
//
// - 先に npm run web:build で dist-web を作っておく。
// - できるもの: <out>/dist/（index.html・view.html・assets … Web 版そのもの、res/ … 同梱の資料、data/ … 教材）。
//   学びアイのサーバー（web/server.mjs）が答えていた「フォルダの中身」は、フォルダごとの _list.json として前もって作る。
// - 科目表（catalog.json）は、選んだ科目だけにする。用語集・関連する授業・年表の索引は、選んだ科目だけで作り直す。
// - サーバーが要る機能（この PC の claude / codex を使う AI、Sign in with ChatGPT、教科書の全文検索）は、このサイトでは動かない。
//   AI は、設定の画面で自分の API キーを入れる方式だけが使える。
// - ノート・成績などの利用者のデータは、もともとブラウザの中にあるので、書き出さない。
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback)
const has = (name) => args.includes(`--${name}`)
const root = resolve(import.meta.dirname, '..')
const dataDir = process.env['MANABI_DATA_DIR'] ?? join(process.env['APPDATA'] ?? '', '学びアイ', 'data')
/** 公開する科目のすべて（--courses public）: 科目表のうち、いまは出さない学校（大学・大学院）を除いたもの */
const HIDDEN_SCHOOLS = ['univ', 'grad']
const publicCourses = () => JSON.parse(readFileSync(join(root, 'resources', 'content', 'catalog.json'), 'utf8')).courses.filter((c) => !HIDDEN_SCHOOLS.includes(c.school)).map((c) => c.id)
const courses = opt('courses', '') === 'public' ? publicCourses() : opt('courses', '').split(',').filter(Boolean)
const outRoot = resolve(opt('out', join(root, '..', 'sites-trial')))
const dist = join(outRoot, 'dist')
const web = join(root, 'dist-web')
if (!courses.length) throw new Error('--courses で、書き出す科目を選んでください（例: --courses jhs2-math,hs-nihonshi）')
if (!existsSync(join(web, 'index.html'))) throw new Error('dist-web がありません。先に npm run web:build を動かしてください。')
const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const stats = { files: 0, bytes: 0 }
const put = (from, to) => {
  if (!existsSync(from)) return false
  if (!has('dry')) {
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true })
  }
  return true
}
const write = (to, value) => {
  if (has('dry')) return
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}

const catalog = readJson(join(root, 'resources', 'content', 'catalog.json'))
const chosen = catalog.courses.filter((c) => courses.includes(c.id))
const missing = courses.filter((id) => !chosen.some((c) => c.id === id))
if (missing.length) throw new Error(`科目表に無い科目です: ${missing.join(', ')}`)
const ofCourse = (name) => courses.some((id) => name.startsWith(`${id}-`) && /^\d+-\d+([.-]|$)/.test(name.slice(id.length + 1)))

if (!has('dry')) rmSync(dist, { recursive: true, force: true })

// 1. Web 版そのもの
put(web, dist)

// 2. 同梱の資料（科目表は、選んだ科目だけ。科目ごとのフォルダも、選んだ科目だけ）
const res = join(root, 'resources')
for (const name of readdirSync(res)) if (name !== 'content') put(join(res, name), join(dist, 'res', name))
for (const name of readdirSync(join(res, 'content'))) {
  const from = join(res, 'content', name)
  if (statSync(from).isDirectory()) {
    if (courses.includes(name)) put(from, join(dist, 'res', 'content', name))
  } else if (/^catalog(\.[a-z]+)?\.json$/.test(name)) {
    const value = readJson(from)
    // 日本語の科目表は配列、訳の科目表は「科目の ID → 訳」の形
    const picked = Array.isArray(value.courses) ? value.courses.filter((c) => courses.includes(c.id)) : Object.fromEntries(Object.entries(value.courses ?? {}).filter(([id]) => courses.includes(id)))
    write(join(dist, 'res', 'content', name), { ...value, courses: picked })
  } else put(from, join(dist, 'res', 'content', name))
}

// 3. 教材
const data = join(dist, 'data')
const copyMatching = (dir, test = ofCourse) => {
  const from = join(dataDir, dir)
  if (!existsSync(from)) return []
  const names = readdirSync(from).filter((name) => !name.endsWith('.tmp') && test(name))
  for (const name of names) put(join(from, name), join(data, dir, name))
  return names
}
const pickKeys = (file, to) => {
  const value = readJson(file)
  if (value && typeof value === 'object') write(to, Object.fromEntries(Object.entries(value).filter(([key]) => ofCourse(key))))
}
const lessonFiles = copyMatching('lessons')
copyMatching('curricula', (name) => courses.includes(name.replace(/\.json$/, '')))
copyMatching('annot')
copyMatching('essay')
pickKeys(join(dataDir, 'lessons-index.json'), join(data, 'lessons-index.json'))

// 教科書の検索用に、科目ごとの本文のまとめ（授業の保存名 → 本文）。サーバーが無いので、ブラウザの中で探す
for (const id of courses) {
  const corpus = {}
  const shipped = join(res, 'content', id)
  for (const name of lessonFiles.filter((n) => n.startsWith(`${id}-`) && n.endsWith('.md'))) corpus[name.slice(0, -3)] = readFileSync(join(dataDir, 'lessons', name), 'utf8')
  for (const name of existsSync(shipped) ? readdirSync(shipped).filter((n) => /-\d+-\d+\.md$/.test(n)) : []) corpus[name.slice(0, -3)] = readFileSync(join(shipped, name), 'utf8')
  write(join(data, 'search', `${id}.json`), corpus)
}

// 挿絵・資料の画像: 選んだ授業の本文に出てくるものと、人物の絵
const media = readJson(join(dataDir, 'media', 'media.json'), { pictures: {}, people: {} })
const used = new Set()
for (const name of lessonFiles.filter((n) => n.endsWith('.md'))) {
  const body = readFileSync(join(dataDir, 'lessons', name), 'utf8')
  for (const m of body.matchAll(/```picture\s*\n\s*(\{[^\n]*\})/g)) {
    try {
      used.add(JSON.parse(m[1]).id)
    } catch {}
  }
}
const pictures = Object.fromEntries(Object.entries(media.pictures ?? {}).filter(([id]) => used.has(id)))
write(join(data, 'media', 'media.json'), { ...media, pictures })
for (const entry of [...Object.values(pictures), ...Object.values(media.people ?? {})]) if (entry?.file) put(join(dataDir, 'media', entry.file), join(data, 'media', entry.file))

// 英語の訳
if (!has('no-en')) {
  const en = join(dataDir, 'i18n', 'en')
  if (existsSync(en)) {
    for (const name of readdirSync(join(en, 'lessons')).filter(ofCourse)) put(join(en, 'lessons', name), join(data, 'i18n', 'en', 'lessons', name))
    for (const id of courses) put(join(en, 'curricula', `${id}.json`), join(data, 'i18n', 'en', 'curricula', `${id}.json`))
    for (const name of ['media.json', 'people.json']) put(join(en, name), join(data, 'i18n', 'en', name))
    pickKeys(join(en, 'lessons-index.json'), join(data, 'i18n', 'en', 'lessons-index.json'))
  }
}

if (has('dry')) {
  console.log(`科目 ${chosen.map((c) => c.id).join(', ')} ／ 授業のファイル ${lessonFiles.length} ／ 画像 ${Object.keys(pictures).length} + 人物 ${Object.keys(media.people ?? {}).length}`)
  process.exit(0)
}

// 4. 用語集・関連する授業・年表の索引を、書き出した授業だけで作り直す
const built = spawnSync(process.execPath, ['--no-warnings', join(root, 'tools', 'build-glossary.mjs')], { env: { ...process.env, MANABI_DATA_DIR: data }, encoding: 'utf8' })
if (built.status !== 0) throw new Error(`索引を作れませんでした: ${built.stderr || built.stdout}`)

// 単元ごとの授業の数のまとめ。科目の一覧の「できた数 / 全体」を、単元表を 1 つずつ取り寄せずに数えるため（src/main/content.ts の curriculumShape）
{
  const summary = {}
  for (const id of courses) {
    const curriculum = readJson(join(res, 'content', id, 'curriculum.json')) ?? readJson(join(data, 'curricula', `${id}.json`))
    if (curriculum?.units?.length) summary[id] = curriculum.units.map((unit) => (unit.lessons ?? []).length)
  }
  write(join(data, 'curricula', '_summary.json'), summary)
}

// 5. フォルダの中身の一覧（_list.json）。学びアイのサーバーの「?list=1」と同じ形（名前 → [大きさ, 更新時刻]、フォルダは 0）
function listFolders(dir) {
  const out = {}
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '_list.json') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out[entry.name] = 0
      listFolders(full)
    } else {
      const s = statSync(full)
      out[entry.name] = [s.size, Math.round(s.mtimeMs)]
    }
  }
  writeFileSync(join(dir, '_list.json'), JSON.stringify(out), 'utf8')
}
listFolders(join(dist, 'res'))
listFolders(data)

// 6. 数える
let largest = ['', 0]
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else {
      const size = statSync(full).size
      stats.files += 1
      stats.bytes += size
      if (size > largest[1]) largest = [full.slice(dist.length + 1), size]
    }
  }
}
walk(dist)
console.log(built.stdout.trim().split('\n').slice(-3).join('\n'))
console.log(`書き出しました: ${dist}`)
console.log(`科目 ${chosen.length}（${chosen.map((c) => c.id).join(', ')}）／ 授業のファイル ${lessonFiles.length} ／ 画像 ${Object.keys(pictures).length} + 人物 ${Object.keys(media.people ?? {}).length}`)
console.log(`ファイル ${stats.files} 個・合わせて ${(stats.bytes / 1024 / 1024).toFixed(1)} MB ／ いちばん大きいファイル ${largest[0]}（${(largest[1] / 1024 / 1024).toFixed(1)} MB）`)
