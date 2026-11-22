// codex（ChatGPT のプランのログインで動かす）を呼ぶ部品。tools/inspect-extras.mjs・deepen-lessons.mjs と同じやり方。
// API の鍵は渡さない（従量の料金は使わない）。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** codex に 1 回たずねる。返すもの: { message, usage, seconds, thread } */
export function codexExec({ input, workDir, model = 'gpt-6.2-sol', effort = 'high', schema = '', ephemeral = true, timeoutMs = 30 * 60_000 }) {
  return new Promise((done, fail) => {
    const cli = ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--sandbox', 'read-only', '-C', workDir, '-m', model, '-c', `model_reasoning_effort=${effort}`]
    if (ephemeral) cli.push('--ephemeral')
    if (schema) cli.push('--output-schema', schema)
    cli.push('-')
    const started = Date.now()
    const env = { ...process.env }
    delete env.CODEX_API_KEY
    delete env.OPENAI_API_KEY
    const child = spawn('codex', cli, { cwd: workDir, windowsHide: true, env })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    let buffer = ''
    let stderr = ''
    let message = ''
    let failure = ''
    let usage = null
    let thread = ''
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
        if (event.type === 'thread.started') thread = event.thread_id
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') message = event.item.text ?? message
        if (event.type === 'turn.completed') usage = event.usage
        if (event.type === 'error' || event.type === 'turn.failed') failure = event.message ?? event.error?.message ?? failure
      }
    })
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-1500)))
    child.on('error', (error) => {
      clearTimeout(timer)
      fail(new Error(`codex を起動できませんでした: ${error.message}`))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const seconds = Math.round((Date.now() - started) / 1000)
      if (message && usage) done({ message, usage, seconds, thread })
      else fail(new Error(failure || `codex から返事がありませんでした（コード ${code}、${seconds} 秒）${stderr.trim().slice(-300)}`))
    })
    child.stdin.end(input, 'utf8')
  })
}

/**
 * 週の使用割合を読む: 短い問いを 1 回送り（記録を残す）、その記録に書かれた割合を読んで、記録を消す。
 * 返すもの: { percent（週の枠）, resetsAt, shortPercent, shortResetsAt } か null
 */
export async function codexWeek({ workDir, model = 'gpt-6.2-sol' }) {
  const answer = await codexExec({ input: '「はい」とだけ答えてください。', workDir, model, effort: 'low', ephemeral: false, timeoutMs: 3 * 60_000 })
  let limits = null
  const now = new Date()
  for (const d of [now, new Date(now.getTime() - 86_400_000)]) {
    const dir = join(homedir(), '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    const found = existsSync(dir) && readdirSync(dir).find((f) => f.includes(answer.thread))
    if (!found) continue
    const match = [...readFileSync(join(dir, found), 'utf8').matchAll(/"rate_limits":(\{.*?"rate_limit_reached_type":[^}]*\})/g)].pop()
    try {
      if (match) limits = JSON.parse(match[1])
    } catch {}
    break
  }
  if (answer.thread) spawnSync('codex', ['delete', '--force', answer.thread], { windowsHide: true })
  const windows = [limits?.primary, limits?.secondary].filter(Boolean)
  if (!windows.length) return null
  const weekly = windows.find((w) => w.window_minutes >= 10000) ?? windows.sort((a, b) => b.used_percent - a.used_percent)[0]
  const short = windows.find((w) => w !== weekly)
  return { percent: weekly.used_percent, resetsAt: weekly.resets_at * 1000, shortPercent: short?.used_percent ?? null, shortResetsAt: short ? short.resets_at * 1000 : 0 }
}

/** API 換算の料金（ドル）。見くらべのための目安 */
export const codexPrice = (u) => {
  const cached = Number(u?.cached_input_tokens) || 0
  const input = Math.max(0, (Number(u?.input_tokens) || 0) - cached)
  return (input * 2 + cached * 0.1 + (Number(u?.output_tokens) || 0) * 10) / 1e6
}

export const parseJson = (text) => JSON.parse(String(text).replace(/^```(?:json)?\n?|\n?```$/g, ''))
