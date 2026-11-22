import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { aiTempDir, aiWorkDir } from '../paths'
import { t } from '@shared/i18n'

export interface CodexOptions {
  /** 空文字なら codex CLI の既定モデル */
  model: string
  effort: string
  /** 役割などの指示 */
  system: string
  /** 画像（PNG のバイト列）。指示文の後ろに順番どおり添付される */
  images?: Buffer[]
  /** 指定すると、この JSON Schema に沿った結果を返す */
  jsonSchema?: object
}

/**
 * codex CLI に 1 回問い合わせる。
 *
 * codex は文字を少しずつ返す形式に対応していないので、返答はまとめて届く。
 * 会話の続きは、これまでのやりとりを毎回渡すことで再現する（ユーザーの codex の履歴を汚さないため、
 * セッションは保存しない）。コマンド実行は読み取り専用の枠内に制限し、空の作業フォルダで動かす。
 */
export async function codexOnce(options: CodexOptions, prompt: string): Promise<string> {
  const temp: string[] = []
  const tempFile = async (name: string, data: string | Buffer) => {
    const file = join(aiTempDir(), `${randomUUID()}-${name}`)
    await writeFile(file, data)
    temp.push(file)
    return file
  }

  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--sandbox', 'read-only',
    '-C', aiWorkDir(),
    '-c', `model_reasoning_effort=${options.effort}`,
    // -c の値は TOML として解釈される。JSON の文字列表記は TOML の文字列としても正しい。
    '-c', `developer_instructions=${JSON.stringify(t('あなたは学習アプリの中で、与えられた役割として文章で応答します。コマンドの実行やファイルの操作は一切行いません。'))}`,
  ]
  // 役割や教材の本文は長くなるので、コマンドライン引数ではなく標準入力の先頭に置く
  // （Windows はコマンドライン全体の長さに上限がある）
  const input = `${options.system}\n\n────────\n\n${prompt}`
  if (options.model) args.push('-m', options.model)
  if (options.jsonSchema) args.push('--output-schema', await tempFile('schema.json', JSON.stringify(options.jsonSchema)))
  for (const [i, image] of (options.images ?? []).entries()) args.push('-i', await tempFile(`page-${i + 1}.png`, image))

  try {
    return await new Promise<string>((resolve, reject) => {
      // 指示文は標準入力から渡す（コマンドライン引数の長さ制限と、-i が後続の引数を取り込むのを避ける）
      const child = spawn('codex', args, { cwd: aiWorkDir(), windowsHide: true })
      let message = ''
      let failure = ''
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-2000)
      })
      child.on('error', (error) => reject(new Error(t('codex を起動できませんでした: {0}', error.message))))
      createInterface({ input: child.stdout }).on('line', (line) => {
        let event: any
        try {
          event = JSON.parse(line)
        } catch {
          return
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') message = event.item.text ?? message
        if (event.type === 'error' || event.type === 'turn.failed') failure = event.message ?? event.error?.message ?? failure
      })
      child.on('exit', (code) => {
        if (message) resolve(message)
        else reject(new Error(failure || t('codex から返答がありませんでした（コード {0}）。{1}', code, stderr.trim())))
      })
      child.stdin.end(input, 'utf8')
    })
  } finally {
    await Promise.all(temp.map((file) => unlink(file).catch(() => undefined)))
  }
}
