import { spawn, type ChildProcess } from 'node:child_process'

/**
 * 英語の読み上げ（予備の方法）。
 *
 * 画面側の読み上げ（speechSynthesis）は、Windows の新しい系統の音声しか使えず、日本語版の Windows には
 * ふつう日本語の音声しか入っていない。一方、昔からある系統（SAPI）には、英語の音声（Microsoft Zira など）が
 * 入っていることが多い。そこで、画面側に英語の音声が無いときは、こちらの系統で読み上げる。
 *
 * PowerShell を 1 つ起動したままにして、読み上げる文章を 1 行ずつ送る（毎回起動すると、話しはじめるまでが遅い）。
 */

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*' } | Sort-Object { $_.VoiceInfo.Culture.Name -ne 'en-US' } | Select-Object -First 1
if (-not $voice) { [Console]::Out.WriteLine('none'); exit }
$s.SelectVoice($voice.VoiceInfo.Name)
$s.Rate = -1
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $s.SpeakAsyncCancelAll()
  if ($line.Length -gt 0) {
    $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    [void]$s.SpeakAsync($text)
  }
}
`

let daemon: ChildProcess | null = null
let ready: Promise<boolean> | null = null

function start(): Promise<boolean> {
  ready ??= new Promise<boolean>((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let answered = false
    const answer = (ok: boolean) => {
      if (answered) return
      answered = true
      if (ok) daemon = child
      resolve(ok)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (text.includes('ready')) answer(true)
      else if (text.includes('none')) answer(false)
    })
    child.on('error', () => answer(false))
    child.on('exit', () => {
      answer(false)
      if (daemon === child) {
        daemon = null
        ready = null
      }
    })
    setTimeout(() => answer(false), 15000).unref()
  })
  return ready
}

/** 英語を読み上げられる音声が、この PC（SAPI の系統）に入っているか */
export function systemVoiceReady(): Promise<boolean> {
  return start()
}

function send(line: string): void {
  if (daemon && daemon.stdin && !daemon.stdin.destroyed) daemon.stdin.write(`${line}\n`)
}

/** 読み上げる（前の読み上げは止める）。自動確認のあいだは、音を出さない */
export async function systemSpeak(text: string): Promise<void> {
  if (process.env['MANABI_DATA_DIR'] || !(await start())) return
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 1000)
  if (clean) send(Buffer.from(clean, 'utf8').toString('base64'))
}

export function systemStop(): void {
  send('')
}

/** アプリを終えるときに、読み上げ用のプロセスも終える */
export function closeTts(): void {
  daemon?.kill()
  daemon = null
  ready = null
}
