// claude の道具（claude -p）を 1 回呼ぶところと、使用量の見はりを、訳す道具（translate-lessons.mjs）と
// 読み直す道具（review-translations.mjs）で共有する。
import { spawn } from 'node:child_process'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 使用量の見はり。claude が知らせてくる使用割合が、5 時間あたり five・週あたり week を超えたら休む。
 *
 * - 休んでいるあいだは、probeMinutes 分ごと（回復の時刻が先に来れば、その時刻）に「1 件だけ」仕事を通して、
 *   その応答で使用割合を確かめる。回復していれば全員が続け、まだなら、また休む。
 *   （上限は、決まった時刻より前にもどされることがある。全員が一度に試すと、それだけで使用量が進むので、試すのは 1 件ずつ）
 * - 「上限が近い」という警告（allowed_warning）は、止まる合図ではない。休むかどうかは割合で決める。
 *   five・week を 1 より大きくすると、割合では休まず、上限に達して使えなくなったときだけ休む。
 * - wait が false のときは、休みに入ったら enter() が false を返す（道具は、そこで終わる）。
 */
export function createLimiter({ five = 0.85, week = 0.86, wait = true, probeMinutes = 60, log = console.log, onPause = () => undefined } = {}) {
  let info = null
  let paused = false
  let pauseUntil = 0
  let why = ''
  let probing = false

  function pause(resetAt, reason, minutes = probeMinutes) {
    const now = Date.now()
    const probe = now + minutes * 60_000
    const until = resetAt > now ? Math.min(resetAt + 90_000, probe) : probe
    const fresh = !paused
    paused = true
    pauseUntil = until
    why = reason
    if (fresh) {
      log(`${reason}なので、休みます（${new Date(until).toLocaleString('ja-JP')} に 1 件だけ試して、回復していれば続けます）`)
      onPause()
    }
  }

  return {
    /** claude の rate_limit_event を受けとる */
    note(rateLimitInfo) {
      info = rateLimitInfo
      const f = info?.unifiedWindows?.five_hour
      const w = info?.unifiedWindows?.seven_day
      const at = (x) => (Number(x?.resetsAt) || 0) * 1000
      if (w && w.utilization >= week) pause(at(w), `週の使用量が ${Math.round(w.utilization * 100)}%`)
      else if (f && f.utilization >= five) pause(at(f), `5 時間あたりの使用量が ${Math.round(f.utilization * 100)}%`)
      else if (info?.status && !['allowed', 'allowed_warning'].includes(info.status)) pause((Number(info.resetsAt) || 0) * 1000, `上限に達した（${info.status}）`, 30)
      else if (paused) {
        paused = false
        log('回復したので、続けます')
      }
    },
    /** 使用割合の知らせが無いまま、呼び出しが失敗したとき（上限のせいらしければ、休む） */
    fail(message) {
      if (/limit|usage|quota|429|rate/i.test(String(message))) pause(0, `上限に達した（${String(message).slice(0, 80)}）`, 30)
    },
    /** 仕事を 1 件始めてよくなるまで待つ。返すのは、leave() に渡す札。wait が false で休みに入っていたら null */
    async enter() {
      for (;;) {
        if (!paused) return { probe: false }
        if (!wait) return null
        const now = Date.now()
        if (now < pauseUntil) {
          await sleep(Math.min(pauseUntil - now, 60_000))
          continue
        }
        if (probing) {
          await sleep(15_000)
          continue
        }
        probing = true
        return { probe: true }
      }
    },
    /** 仕事が 1 件終わったら呼ぶ */
    leave(token) {
      if (!token?.probe) return
      probing = false
      // 試した 1 件が、使用割合の知らせを出さずに終わった（通信の失敗など）ときは、少し待ってからもう一度試す
      if (paused && pauseUntil <= Date.now()) pauseUntil = Date.now() + 10 * 60_000
    },
    get paused() {
      return paused
    },
    /** 進み具合の記録に書くもの */
    state() {
      const w = info?.unifiedWindows
      return { five: w?.five_hour?.utilization ?? null, week: w?.seven_day?.utilization ?? null, paused, pauseUntil: paused ? new Date(pauseUntil).toISOString() : null, pauseWhy: paused ? why : '' }
    },
  }
}

/**
 * claude を 1 回呼ぶ。返すのは、返事の文（text）、決められた形の返事（structured。schema を渡したとき）、API 換算の金額（cost）。
 * 道具は使わせず、設定やスキルも読みこませない（訳す・読み直すだけの、1 回きりの問い合わせ）。
 */
export function askClaude({ systemFile, userText, model = 'sonnet', effort = 'low', schema = null, cwd, limiter = null, timeoutMs = 8 * 60_000 }) {
  return new Promise((done, fail) => {
    const cli = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--effort', effort, '--system-prompt-file', systemFile, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--setting-sources', '']
    if (schema) cli.push('--json-schema', JSON.stringify(schema))
    const child = spawn('claude', cli, { cwd, windowsHide: true })
    let buffer = ''
    let stderr = ''
    let result = null
    const timer = setTimeout(() => child.kill(), timeoutMs)
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
        if (event.type === 'rate_limit_event') limiter?.note(event.rate_limit_info)
        if (event.type === 'result') result = event
      }
    })
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-1500)))
    child.on('error', (error) => {
      clearTimeout(timer)
      fail(error)
    })
    child.on('exit', () => {
      clearTimeout(timer)
      if (!result || result.is_error) return fail(new Error(`claude が失敗しました: ${String(result?.result ?? stderr).slice(0, 300)}`))
      done({ text: typeof result.result === 'string' ? result.result : '', structured: result.structured_output ?? null, cost: result.total_cost_usd ?? 0 })
    })
    child.stdin.end(userText, 'utf8')
  })
}
