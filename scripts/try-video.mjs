// 授業を 1 つ選んで、動画（試作）を作る: 台本（AI）→ 声（読み上げソフト）→ 画面の確認 → 動画ファイルへの書き出し。
//   npm run build && node scripts/try-video.mjs <授業の ID> [--redo] [--no-record] [--install]
//
// ふだんのデータの写し（.try/video-data）で動かす。できたものは .try/video-data/videos/<授業>/ に置かれ、
// 場面ごとの画面の写真は .try/video-shots/ に出る。
//   --redo       台本から作り直す
//   --no-record  動画ファイルへの書き出しをしない（台本・声・画面の確認まで）
//   --install    できた動画を、ふだんのデータ（%APPDATA%\学びアイ\data\videos\）にも入れる（アプリを閉じているときに使う）
// 読み上げソフト（AivisSpeech）を、先に起動しておく。
import electronPath from 'electron'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const lessonId = args.find((a) => !a.startsWith('--'))
if (!lessonId) throw new Error('授業の ID を指定してください（例: jhs1-science-5-3）')
const [id, variant] = lessonId.endsWith('.deep') ? [lessonId.slice(0, -5), 'deep'] : [lessonId, 'standard']
const course = id.replace(/-\d+-\d+$/, '')

const real = join(process.env['APPDATA'], '学びアイ', 'data')
const data = join(root, '.try', 'video-data')
const shots = join(root, '.try', 'video-shots')
mkdirSync(join(data, 'lessons'), { recursive: true })
rmSync(shots, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })
for (const name of ['curricula', 'lessons-index.json', 'settings.json']) cpSync(join(real, name), join(data, name), { recursive: true })
for (const file of readdirSync(join(real, 'lessons')).filter((f) => f.startsWith(`${course}-`))) cpSync(join(real, 'lessons', file), join(data, 'lessons', file))
// 本文に挿絵があれば、その画像も写す
const body = readFileSync(join(data, 'lessons', `${lessonId}.md`), 'utf8')
if (body.includes('```picture') && existsSync(join(real, 'media', 'media.json'))) {
  const manifest = JSON.parse(readFileSync(join(real, 'media', 'media.json'), 'utf8'))
  mkdirSync(join(data, 'media'), { recursive: true })
  cpSync(join(real, 'media', 'media.json'), join(data, 'media', 'media.json'))
  for (const m of body.matchAll(/"id":"([^"]+)"/g)) {
    const file = manifest.pictures?.[m[1]]?.file
    if (file) cpSync(join(real, 'media', file), join(data, 'media', file))
  }
}

const app = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, MANABI_DATA_DIR: data } })
const errors = []
try {
  const home = await app.firstWindow()
  await home.waitForSelector('.home-hello')

  const voice = await home.evaluate(() => window.manabi.video.voice())
  if (!voice.ready) throw new Error('読み上げソフト（AivisSpeech）が動いていません。')
  console.log(new Date().toLocaleTimeString('ja-JP'), '台本と声を作ります…')
  const started = Date.now()
  const info = await home.evaluate(([lesson, v, redo]) => window.manabi.video.make(lesson, v, redo), [id, variant, flag('--redo')])
  const seconds = info.durations.reduce((a, b) => a + b, 0)
  const lines = info.script.scenes.flatMap((scene) => scene.lines)
  console.log(new Date().toLocaleTimeString('ja-JP'), `できました（${Math.round((Date.now() - started) / 1000)} 秒）: 場面 ${info.script.scenes.length}、せりふ ${lines.length}、字幕 ${lines.reduce((n, l) => n + l.text.length, 0)} 字、声 ${Math.round(seconds)} 秒`)

  // 台本を、読みやすい形でも書き出す（確認用）
  const dir = join(data, 'videos', lessonId)
  const kana = JSON.parse(readFileSync(join(dir, 'audio.json'), 'utf8')).lines
  let n = 0
  const text = info.script.scenes
    .map((scene, s) => [`■ 場面 ${s + 1}［${scene.kind}${scene.ref ? ` ${scene.ref}` : ''}］${scene.heading}`, ...scene.items.map((item, i) => `   ${i + 1}) ${item}`), ...scene.lines.map((l) => `  ${l.speaker}(${l.expression || '-'})${scene.kind === 'board' ? ` 見せる:${l.show}` : ''}${Object.keys(l.set).length ? ` 動かす:${JSON.stringify(l.set)}` : ''} ${info.durations[n].toFixed(1)}秒\n     字幕: ${l.text}\n     読み: ${l.say}\n     かな: ${kana[n++].kana}`)].join('\n'))
    .join('\n\n')
  writeFileSync(join(dir, 'script.txt'), text, 'utf8')

  const [video] = await Promise.all([app.waitForEvent('window'), home.evaluate(([lesson, v]) => window.manabi.view.open('video', { lessonId: lesson, variant: v }), [id, variant])])
  video.on('pageerror', (e) => errors.push(e.message))
  video.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await video.waitForSelector('.video-play:not([disabled])', { timeout: 60000 })
  await video.waitForFunction(() => document.querySelector('.video-play')?.textContent?.includes('再生'))

  // 場面ごとに、最後のせりふの画面を写真にとる（動く図解は、せりふごとに）
  let at = 0
  for (const [s, scene] of info.script.scenes.entries()) {
    const picks = scene.kind === 'sim' ? scene.lines.map((_l, i) => i) : [scene.lines.length - 1]
    for (const l of picks) {
      await video.locator('.video-seek').fill(String(at + l))
      await video.waitForTimeout(scene.kind === 'sim' ? 3300 : 900)
      await video.locator('.video-stage').screenshot({ path: join(shots, `${String(s + 1).padStart(2, '0')}-${scene.kind}${scene.kind === 'sim' ? `-${l + 1}` : ''}.png`) })
    }
    at += scene.lines.length
  }
  await video.locator('.video-seek').fill('0')
  console.log(`画面の写真: ${shots}`)

  if (!flag('--no-record')) {
    console.log(new Date().toLocaleTimeString('ja-JP'), `動画ファイルに書き出します（${Math.round(seconds + lines.length * 0.4)} 秒ほど）…`)
    await video.getByRole('button', { name: /動画ファイルに書き出す/ }).click()
    await video.waitForSelector('[data-export]', { timeout: (seconds + lines.length + 240) * 1000 })
    const result = await video.locator('[data-export]').first()
    console.log(new Date().toLocaleTimeString('ja-JP'), await result.getAttribute('data-export'), await result.textContent())
    const file = ['mp4', 'webm'].map((ext) => join(dir, `video.${ext}`)).find(existsSync)
    if (file) {
      try {
        console.log(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size,bit_rate:stream=codec_name,width,height,r_frame_rate,sample_rate', '-of', 'compact', file], { encoding: 'utf8' }).trim())
      } catch {
        console.log('（ffprobe が無いので、動画の中身は調べていません）')
      }
    }
  }
} finally {
  if (errors.length) console.log(`画面のエラー ${errors.length} 件:\n${[...new Set(errors)].slice(0, 8).join('\n')}`)
  await app.close()
}

if (flag('--install')) {
  cpSync(join(data, 'videos', lessonId), join(real, 'videos', lessonId), { recursive: true })
  console.log(`ふだんのデータにも入れました: ${join(real, 'videos', lessonId)}`)
}
