// この PC に入っている claude・codex のコマンドを、1 回ずつ動かす（開発用の方式）。
// 使うのは、Web 版の付属のサーバー（web/server.mjs）と、モデルごとの試しの道具（tools/model-check.mjs）。
// コマンドには道具（ファイル操作など）を使わせず、空の作業フォルダで動かす。使用量は、利用者自身のプランから引かれる。
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OPENAI_DEFAULT, costOf } from '../src/web/ai/providers.ts'

let workDir = ''
let tempDir = ''
/** はじめに 1 回: 作業フォルダと、一時ファイルの置き場を決める */
export function setupCli(dirs) {
  workDir = dirs.workDir
  tempDir = dirs.tempDir
  for (const dir of [workDir, tempDir]) mkdirSync(dir, { recursive: true })
}

export function canRun(command) {
  return new Promise((done) => {
    const child = spawn(command, ['--version'], { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => (child.kill(), done(false)), 8000)
    child.on('error', () => (clearTimeout(timer), done(false)))
    child.on('exit', (code) => (clearTimeout(timer), done(code === 0)))
  })
}
let cli = { at: 0, claude: false, codex: false }
export async function cliStatus() {
  if (Date.now() - cli.at > 60_000) {
    const [claude, codex] = await Promise.all([canRun('claude'), canRun('codex')])
    cli = { at: Date.now(), claude, codex }
  }
  return cli
}

/** API は会話を覚えないが、コマンドには 1 回ぶんの発言しか渡せないので、これまでのやりとりを文にまとめて前に置く */
function flatten(turns) {
  const earlier = turns.slice(0, -1)
  const last = turns.at(-1)
  const past = earlier.length ? `# これまでの会話\n${earlier.map((turn) => `${turn.role === 'user' ? '生徒' : 'あなた'}: ${turn.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')}`).join('\n')}\n\n# 生徒の今回の発言\n` : ''
  const text = past + last.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
  return { text, images: last.content.filter((p) => p.type === 'image').map((p) => p.data) }
}

export function runClaude(call, onDelta = () => undefined) {
  return new Promise((done, fail) => {
    const systemFile = join(tempDir, `system-${randomUUID()}.txt`)
    writeFileSync(systemFile, call.system, 'utf8')
    const cliArgs = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', call.model || 'sonnet', '--effort', call.effort || 'medium', '--system-prompt-file', systemFile, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--setting-sources', '']
    if (call.jsonSchema) cliArgs.push('--json-schema', JSON.stringify(call.jsonSchema))
    const child = spawn('claude', cliArgs, { cwd: workDir, windowsHide: true })
    const timer = setTimeout(() => child.kill(), 10 * 60_000)
    let buffer = ''
    let stderr = ''
    let text = ''
    let result = null
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') {
          text += event.event.delta.text
          onDelta(text)
        } else if (event.type === 'result') {
          result = event
          child.stdin.end()
        }
      }
    })
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-1500)))
    child.on('error', (error) => fail(new Error(`claude を起動できませんでした: ${error.message}`)))
    child.on('exit', () => {
      clearTimeout(timer)
      try {
        unlinkSync(systemFile)
      } catch {}
      if (!result || result.is_error) return fail(new Error(`claude が失敗しました: ${String(result?.result ?? stderr).slice(0, 300)}`))
      const u = result.usage ?? {}
      const cached = Number(u.cache_read_input_tokens) || 0
      done({
        text: call.jsonSchema && result.structured_output ? JSON.stringify(result.structured_output) : text || (typeof result.result === 'string' ? result.result : ''),
        usage: { input: (Number(u.input_tokens) || 0) + cached + (Number(u.cache_creation_input_tokens) || 0), cached, output: Number(u.output_tokens) || 0 },
        // コマンドが知らせてくる「API で同じことをしたときの料金」（実際には、プランの使用量から引かれる）
        cost: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
        model: `claude（${call.model || 'sonnet'}・この PC）`,
      })
    })
    const { text: prompt, images } = flatten(call.turns)
    const content = [...images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })), { type: 'text', text: prompt }]
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`)
  })
}

export function runCodex(call) {
  return new Promise((done, fail) => {
    const temp = []
    const tempFile = (name, data) => {
      const file = join(tempDir, `${randomUUID()}-${name}`)
      writeFileSync(file, data)
      temp.push(file)
      return file
    }
    const { text: prompt, images } = flatten(call.turns)
    const cliArgs = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '-C', workDir, '-c', `model_reasoning_effort=${call.effort || 'medium'}`, '-c', `developer_instructions=${JSON.stringify('あなたは学習アプリの中で、与えられた役割として文章で応答します。コマンドの実行やファイルの操作は一切行いません。')}`]
    if (call.model) cliArgs.push('-m', call.model)
    if (call.jsonSchema) cliArgs.push('--output-schema', tempFile('schema.json', JSON.stringify(call.jsonSchema)))
    images.forEach((data, i) => cliArgs.push('-i', tempFile(`page-${i + 1}.png`, Buffer.from(data, 'base64'))))
    const child = spawn('codex', cliArgs, { cwd: workDir, windowsHide: true })
    const timer = setTimeout(() => child.kill(), 15 * 60_000)
    let buffer = ''
    let stderr = ''
    let message = ''
    let failure = ''
    let usage = null
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') message = event.item.text ?? message
        if (event.type === 'turn.completed') usage = event.usage
        if (event.type === 'error' || event.type === 'turn.failed') failure = event.message ?? event.error?.message ?? failure
      }
    })
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-1500)))
    child.on('error', (error) => fail(new Error(`codex を起動できませんでした: ${error.message}`)))
    child.on('exit', (code) => {
      clearTimeout(timer)
      for (const file of temp) {
        try {
          unlinkSync(file)
        } catch {}
      }
      if (!message) return fail(new Error(failure || `codex から返答がありませんでした（コード ${code}）${stderr.trim().slice(-300)}`))
      const u = { input: Number(usage?.input_tokens) || 0, cached: Number(usage?.cached_input_tokens) || 0, output: Number(usage?.output_tokens) || 0 }
      // 同じ量を API で使ったときの料金の目安（実際には、プランの使用量から引かれる）
      done({ text: message, usage: u, cost: costOf(call.model || OPENAI_DEFAULT, u), model: `codex（${call.model || '既定'}・この PC）` })
    })
    child.stdin.end(`${call.system}\n\n────────\n\n${prompt}`, 'utf8')
  })
}
