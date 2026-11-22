import type { AiProviderId, AiSettings as AiSettingsValue } from '@shared/types'
import { api, useLoad } from '../lib/hooks'
import { t, tx } from '@/lib/i18n'

const CLAUDE_MODELS = [
  { value: 'haiku', label: t('Haiku（速い）') },
  { value: 'sonnet', label: t('Sonnet（標準）') },
  { value: 'opus', label: t('Opus（高性能）') },
]
const EFFORTS: Record<AiProviderId, { value: string; label: string }[]> = {
  claude: [
    { value: 'low', label: t('少なめ') },
    { value: 'medium', label: t('ふつう') },
    { value: 'high', label: t('多め') },
    { value: 'xhigh', label: t('かなり多め') },
  ],
  codex: [
    { value: 'low', label: t('少なめ') },
    { value: 'medium', label: t('ふつう') },
    { value: 'high', label: t('多め') },
  ],
}

/** 応答する AI・モデル・思考量の切り替え。変更はすべてのウィンドウに反映される。 */
export function AiSettings({ compact }: { compact?: boolean }) {
  const settings = useLoad(() => api.settings.get(), [], ['settings'])
  const status = useLoad(() => api.ai.status(), [], ['ai-link'])
  const ai = settings.data?.ai
  if (!ai) return null

  const update = (patch: Partial<AiSettingsValue>) => {
    const next = { ...ai, ...patch }
    settings.setData({ ...settings.data!, ai: next })
    void api.settings.set({ ai: next })
  }
  const changeProvider = (provider: AiProviderId) => {
    // AI を切り替えたら、その AI の標準的な設定にもどす
    update(provider === 'claude' ? { provider, model: 'sonnet', effort: 'medium' } : { provider, model: '', effort: 'medium' })
  }
  const unavailable = status.data && !status.data[ai.provider]

  return (
    <div className={`ai-settings ${compact ? 'ai-settings-compact' : ''}`}>
      <label>
        <span>AI</span>
        <select value={ai.provider} onChange={(e) => changeProvider(e.target.value as AiProviderId)}>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </label>
      <label>
        <span>{t('モデル')}</span>
        {ai.provider === 'claude' ? (
          <select value={ai.model} onChange={(e) => update({ model: e.target.value })}>
            {CLAUDE_MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={ai.model}
            placeholder={t('既定のモデル')}
            spellCheck={false}
            onChange={(e) => update({ model: e.target.value.trim() })}
          />
        )}
      </label>
      <label>
        <span>{t('思考量')}</span>
        <select value={ai.effort} onChange={(e) => update({ effort: e.target.value })}>
          {EFFORTS[ai.provider].map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {unavailable && (
        <p className="ai-settings-warning">
          {status.data?.route
            ? status.data.route === 'siwc' && ai.provider === 'claude'
              ? t('Sign in with ChatGPT で使えるのは、Codex（OpenAI）の側だけです。AI を Codex に切りかえてください。')
              : t('AI がまだ使えません。設定の画面の「AI のつなぎ方」で、API キーの登録か、ChatGPT へのサインインをしてください。')
            : tx('{0} のコマンドが見つかりません。インストールとログインを確認してください。', ai.provider)}</p>
      )}
    </div>
  )
}
