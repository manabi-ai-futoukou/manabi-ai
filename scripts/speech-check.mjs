// 音声認識を、実物で確かめるスクリプト。
//
//   npm run build && node scripts/speech-check.mjs            確認だけ（未準備なら、そう表示して終わる）
//   npm run build && node scripts/speech-check.mjs --install  未準備なら、アプリの「準備する」ボタンを押して取り寄せる（約 550MB）
//
// マイクの代わりに、Windows の読み上げ音声で作った音声ファイルを使う（本物のマイクも、人の声も要らない）。
// エンジンとモデルは、ふだんのアプリと同じ場所（%APPDATA%\学びアイ\speech）のものを使う。
import electronPath from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const install = process.argv.includes('--install')
const root = resolve(import.meta.dirname, '..')
const outDir = join(root, '.smoke-speech')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(outDir, 'data'), { recursive: true })
const speechDir = join(process.env.APPDATA, '学びアイ', 'speech')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'NG  '} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Windows の読み上げ音声で、文章を WAV にする。rate は 16000（直接わたす用）か 48000（マイクの代わり用） */
function synthesize(file, text, rate, culture) {
  const script = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${rate}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::${rate === 16000 ? 'Mono' : 'Stereo'})
$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq '${culture}' } | Select-Object -First 1
if (-not $v) { throw '${culture} の読み上げ音声がありません' }
$s.SelectVoice($v.VoiceInfo.Name)
$s.SetOutputToWaveFile($env:MANABI_WAV, $f)
$p = New-Object System.Speech.Synthesis.PromptBuilder([Globalization.CultureInfo]'${culture}')
$p.AppendBreak([TimeSpan]::FromMilliseconds(400))
$p.AppendText($env:MANABI_TEXT)
$p.AppendBreak([TimeSpan]::FromMilliseconds(1500))
$s.Speak($p)
$s.Dispose()
($s.Voice.Name)`
  execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { env: { ...process.env, MANABI_WAV: file, MANABI_TEXT: text }, stdio: ['ignore', 'pipe', 'inherit'] })
  return file
}

const JA = 'こんにちは。今日は数学の勉強をします。'
const EN = 'I like music. Do you like music?'
const jaDirect = synthesize(join(outDir, 'ja-16k.wav'), JA, 16000, 'ja-JP')
const jaMic = synthesize(join(outDir, 'ja-mic.wav'), JA, 48000, 'ja-JP')
const enMic = synthesize(join(outDir, 'en-mic.wav'), EN, 48000, 'en-US')

async function launch(micFile) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [root],
    env: { ...process.env, MANABI_DATA_DIR: join(outDir, 'data'), MANABI_SPEECH_DIR: speechDir, MANABI_FAKE_MIC: micFile, MANABI_NO_AI: '1' },
  })
  const home = await app.firstWindow()
  await home.waitForSelector('.speech-setup')
  return { app, home }
}
const openEikaiwa = async (app, home) => {
  const [win] = await Promise.all([app.waitForEvent('window'), home.getByRole('button', { name: '英会話', exact: true }).click()])
  await win.waitForSelector('.composer textarea')
  return win
}
/** マイクのボタンを押し、seconds 秒だけ録音して、もう一度押す */
const record = async (win, seconds, photo) => {
  await win.locator('.mic').last().click()
  await win.waitForSelector('.mic[data-phase="recording"]', { timeout: 10000 })
  if (photo) await win.screenshot({ path: join(outDir, photo) })
  await win.waitForTimeout(seconds * 1000)
  await win.locator('.mic[data-phase="recording"]').click()
}

// ───────── 1 回目: 準備の確認、日本語の文字起こし、マイクからの入力 ─────────
let { app, home } = await launch(jaMic)
try {
  let status = await home.evaluate(() => window.manabi.speech.status())
  if (!status.ready && install) {
    console.log('     音声認識を取り寄せます（エンジン 8.5MB + モデル 547MB）…')
    const began = Date.now()
    await home.locator('.speech-setup').getByRole('button', { name: /音声認識を準備する/ }).click()
    let last = ''
    for (;;) {
      await home.waitForTimeout(5000)
      status = await home.evaluate(() => window.manabi.speech.status())
      const line = status.progress ? `${status.progress.label} ${Math.round(status.progress.received / 1048576)} / ${Math.round(status.progress.total / 1048576)} MB` : ''
      if (line && line.slice(0, -6) !== last.slice(0, -6) && Math.round(status.progress.received / 1048576) % 50 < 12) console.log(`     ${line}`)
      last = line || last
      if (status.ready || status.error || (!status.progress && Date.now() - began > 15000)) break
      if (Date.now() - began > 40 * 60 * 1000) break
    }
    check('準備: アプリのボタンから、エンジンとモデルを取り寄せられる（SHA-256 の照合つき）', status.ready, status.error ?? `${Math.round((Date.now() - began) / 1000)} 秒`)
  }
  if (!status.ready) {
    console.log('音声認識は、まだ準備されていません。--install を付けて実行するか、アプリのホーム「音声入力」から準備してください。')
  } else {
    await home.waitForFunction(() => document.querySelector('.speech-state')?.dataset.ready === 'true', null, { timeout: 10000 })
    check('準備: ホームに「文字にできます」と表示される', true, `モデル: ${status.model}`)

    // 音声ファイルを直接わたして文字にする（1 回目はモデルの読みこみをふくむ）
    const bytes = [...readFileSync(jaDirect)]
    let began = Date.now()
    const first = await home.evaluate(({ bytes }) => window.manabi.speech.transcribe(new Uint8Array(bytes).buffer, 'ja'), { bytes })
    const firstMs = Date.now() - began
    began = Date.now()
    const second = await home.evaluate(({ bytes }) => window.manabi.speech.transcribe(new Uint8Array(bytes).buffer, 'ja'), { bytes })
    check('文字起こし: 日本語の音声を文字にできる', /数学/.test(first) && /勉強/.test(first), `「${first}」 1 回目 ${firstMs} ミリ秒、2 回目 ${Date.now() - began} ミリ秒`)
    check('文字起こし: 同じ音声なら同じ結果になる', first === second)

    // マイク → 入力欄（送信はされない）
    const eikaiwa = await openEikaiwa(app, home)
    await record(eikaiwa, 5)
    await eikaiwa.waitForFunction(() => document.querySelector('.composer textarea').value.length > 3, null, { timeout: 60000 })
    const typed = await eikaiwa.locator('.composer textarea').inputValue()
    const sent = await eikaiwa.locator('.message').count()
    check('マイク: 話した言葉が入力欄に入り、送信はされない（送る前に確かめられる）', /数学|勉強|こんにちは/.test(typed) && sent === 0, `「${typed}」`)
    await eikaiwa.screenshot({ path: join(outDir, 'mic-dictation.png') })
  }
} catch (error) {
  check('途中で止まった', false, String(error).slice(0, 400))
} finally {
  await app.close().catch(() => {})
}

// ───────── 2 回目: 英会話の発音の確認 ─────────
if (existsSync(join(speechDir, 'models')) && checks.every((c) => c.ok) && checks.length) {
  ;({ app, home } = await launch(enMic))
  try {
    const eikaiwa = await openEikaiwa(app, home)
    await eikaiwa.locator('.composer textarea').fill(EN)
    await eikaiwa.getByRole('button', { name: '次へ' }).click()
    await eikaiwa.waitForSelector('.say-target')
    check('英会話: 音声認識が準備済みなら、準備の案内は出ない', (await eikaiwa.locator('.say .speech-setup').count()) === 0)
    await record(eikaiwa, 5, 'say-recording.png')
    // 録音中の表示が、言う英文に重なっていないこと
    const overlap = await eikaiwa.evaluate(() => {
      const target = document.querySelector('.say-target')?.getBoundingClientRect()
      return !!target && [...document.querySelectorAll('.mic-note')].some((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.left < target.right && r.right > target.left && r.top < target.bottom && r.bottom > target.top
      })
    })
    check('英会話: 録音中の表示が、言う英文をかくさない', !overlap)
    await eikaiwa.waitForSelector('.say-result', { timeout: 60000 })
    await eikaiwa.screenshot({ path: join(outDir, 'say-result.png') })
    const pass = (await eikaiwa.locator('.say-result').getAttribute('data-pass')) === 'true'
    const result = (await eikaiwa.locator('.say-result').innerText()).replace(/\n/g, ' ')
    check('英会話: 英語の音声で言った英文が聞き取られ、発音の確認に合格する', pass, result)
    if (pass) {
      // AI を呼ばない設定なので、送信は失敗して入力がもどる。送ろうとしたこと（自分の発言が出ること）だけ確かめる
      await eikaiwa.waitForSelector('.message-user, .chat-error', { timeout: 10000 })
      check('英会話: 合格すると、相手に送られる', true)
    }
  } catch (error) {
    check('途中で止まった', false, String(error).slice(0, 400))
  } finally {
    await app.close().catch(() => {})
  }
}

const failed = checks.filter((c) => !c.ok).length
console.log(`\n${checks.length - failed} / ${checks.length} 項目が通りました。写真: ${outDir}`)
process.exit(failed ? 1 : 0)
