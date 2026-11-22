import type { AiSettings } from '@shared/types'
import { claudeOnce, type ClaudeContent } from './claude'
import { codexOnce } from './codex'
import { t } from '@shared/i18n'
import { isJa, langName } from './lang'

/** 自動確認（AI を使わない設定）のときは、AI を呼ばずに止める */
function guard(): void {
  if (process.env['MANABI_NO_AI']) throw new Error(t('自動確認のため、AI は呼びませんでした。'))
}

/**
 * 日本語以外で表示しているときに、指示文の最後に足す 1 行。
 * 指示文の中の「the learner's display language」は、ここで示す言語のこと。
 * （日本語の言葉や漢字の練習のように、練習する中身が別の言語に決まっているものは、指示文のほうにそう書いてある）
 */
const withLanguage = (system: string) => (isJa() ? system : `${system}\n\nThe learner's display language: ${langName()}. Unless these instructions say that something must be in another language, write everything the learner will read in ${langName()}.`)

/** 1 回だけ問い合わせて、決められた形（JSON Schema）の結果を受け取る */
export async function askStructured<T>(ai: AiSettings, system: string, prompt: string, schema: object, images: Buffer[] = []): Promise<T> {
  guard()
  if (ai.provider === 'claude') {
    const content: ClaudeContent[] = [
      ...images.map((image) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/png' as const, data: image.toString('base64') },
      })),
      { type: 'text', text: prompt },
    ]
    return claudeOnce<T>({ model: ai.model, effort: ai.effort, system: withLanguage(system), jsonSchema: schema }, content)
  }
  const text = await codexOnce({ model: ai.model, effort: ai.effort, system: withLanguage(system), images, jsonSchema: schema }, prompt)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(t('AI の返答を読み取れませんでした。もう一度お試しください。'))
  }
}

/** 1 回だけ問い合わせて、文章を受け取る */
export async function askText(ai: AiSettings, system: string, prompt: string): Promise<string> {
  guard()
  if (ai.provider === 'claude') {
    return claudeOnce<string>({ model: ai.model, effort: ai.effort, system: withLanguage(system) }, [{ type: 'text', text: prompt }])
  }
  return codexOnce({ model: ai.model, effort: ai.effort, system: withLanguage(system) }, prompt)
}
