/**
 * AI へのつなぎ方（Windows 版）。
 *
 *   own-key … 利用者が、自分で契約した API キー（Claude・OpenAI）を入れる。キーは、この PC の中に、Windows の仕組みで暗号化して置く
 *   siwc    … Sign in with ChatGPT。利用者の ChatGPT のプランの枠を使う（OpenAI の側だけ）
 *   relay   … この PC に入っている claude・codex のコマンド。開発用で、配る版（インストーラーで入れたもの）には出さない
 *
 * API を呼ぶところと、設定の読み書きは、Web 版のもの（src/web/ai/）をそのまま使う。
 */
import { join } from 'node:path'
import { safeStorage, shell } from 'electron'
import type { AiLinkPatch, AiLinkState, AiRoute, AiStatus } from '@shared/types'
import { taskOf } from '../../web/ai/routing'
import { allowedRoutes, getAiConfig, setAiConfig, setAllowedRoutes, setFiles, setKeyCodec, setSiwcCaller, setTask } from '../../web/ai/transport'
import { isDevEdition } from '../edition'
import { dataDir } from '../paths'
import { signOut, siwcCall, siwcModels, siwcState, startSignIn } from './siwc'

let ready = false
function ensure(): void {
  if (ready) return
  ready = true
  setFiles(join(dataDir(), 'ai-link.json'), join(dataDir(), 'ai-usage.json'))
  setKeyCodec({
    seal: (value) => (value && safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(value).toString('base64')}` : value),
    open: (value) => {
      if (!value.startsWith('enc:')) return value
      try {
        return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
      } catch {
        // 読めない（別の PC から写したなど）ときは、入れ直してもらう
        return ''
      }
    },
  })
  // 配る版で使えるのは、API キーと Sign in with ChatGPT。この PC のコマンド（claude・codex）は、開発のときだけ
  // （開発用の版かどうかの決め方は、src/main/edition.ts）
  setAllowedRoutes(isDevEdition() ? ['relay', 'own-key', 'siwc'] : ['own-key', 'siwc'])
  setSiwcCaller(siwcCall)
}

/** この PC のコマンド（claude・codex）で動かすか */
export function usesCli(): boolean {
  ensure()
  return getAiConfig().route === 'relay'
}

/** 画面からの要求が、どの仕事のものかを覚えておく（仕事ごとのモデルの割り当てと、使った量の記録に使う） */
export function noteTask(channel: string): void {
  // AI を使わない要求（設定を読む、など）で、進めている仕事の種類を消さない
  if (taskOf(channel) !== 'other') setTask(channel)
}

export function linkState(): AiLinkState {
  ensure()
  const config = getAiConfig()
  return {
    route: config.route as AiRoute,
    routes: allowedRoutes() as AiRoute[],
    anthropicKey: !!config.anthropicKey,
    openaiKey: !!config.openaiKey,
    routing: config.routing,
    siwc: siwcState(),
    siwcModel: config.siwcModel,
  }
}

export function setLink(patch: AiLinkPatch): AiLinkState {
  ensure()
  setAiConfig(patch && typeof patch === 'object' ? patch : {})
  return linkState()
}

/** いまのつなぎ方で、それぞれの AI が使えるか（この PC のコマンドで動かすときは null = コマンドがあるかを調べる） */
export function linkStatus(): AiStatus | null {
  ensure()
  const config = getAiConfig()
  if (config.route === 'relay') return null
  if (config.route === 'own-key') return { claude: !!config.anthropicKey, codex: !!config.openaiKey, route: 'own-key' }
  return { claude: false, codex: siwcState().signedIn, route: 'siwc' }
}

/** Sign in with ChatGPT を始める（いつものブラウザで、OpenAI のページを開く）。終わったら onDone を呼ぶ */
export async function signIn(onDone: () => void): Promise<void> {
  ensure()
  await shell.openExternal(await startSignIn(onDone))
}

export { signOut, siwcModels }
