import { useEffect, useRef, useState } from 'react'
import type { AiLinkPatch, AiRoute } from '@shared/types'
import { api, useLoad } from '../lib/hooks'
import { t } from '@/lib/i18n'

/**
 * AI へのつなぎ方（Windows 版の設定の画面）。利用者の API キーか、Sign in with ChatGPT を選ぶ。
 * Web 版では、上の帯の「AI のつなぎ方」から開く窓が同じ役目なので、ここには何も出さない（本体側が null を返す）。
 */
export function AiLink() {
  const link = useLoad(() => api.ai.link.get(), [], ['ai-link'])
  const [models, setModels] = useState<{ slug: string; name: string }[]>([])
  const [message, setMessage] = useState('')
  const anthropicKey = useRef<HTMLInputElement>(null)
  const openaiKey = useRef<HTMLInputElement>(null)
  const state = link.data
  const signedIn = !!state?.siwc.signedIn

  useEffect(() => {
    if (!signedIn) return setModels([])
    setMessage('')
    void api.ai.link.models().then(setModels, () => setModels([]))
  }, [signedIn])

  if (!state) return null

  const fail = (error: unknown) => setMessage(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error))
  const save = (patch: AiLinkPatch) => {
    setMessage('')
    void api.ai.link.set(patch).then(link.setData, fail)
  }
  const signIn = () => {
    setMessage(t('開いたブラウザで、ChatGPT にサインインして許可してください。終わると、ここに反映されます。'))
    void api.ai.link.signIn().catch(fail)
  }
  const saveKeys = () => {
    const patch: AiLinkPatch = {}
    if (anthropicKey.current?.value) patch.anthropicKey = anthropicKey.current.value
    if (openaiKey.current?.value) patch.openaiKey = openaiKey.current.value
    save(patch)
    if (anthropicKey.current) anthropicKey.current.value = ''
    if (openaiKey.current) openaiKey.current.value = ''
  }

  const option = (value: AiRoute, title: string, note: string, ok: boolean | null) =>
    state.routes.includes(value) && (
      <label className="ai-link-route" data-on={state.route === value}>
        <input type="radio" name="ai-route" checked={state.route === value} onChange={() => save({ route: value })} />
        <span>
          <b>
            {title}
            {ok !== null && <em data-ok={ok}>{ok ? t('使えます') : t('未設定')}</em>}
          </b>
          <small>{note}</small>
        </span>
      </label>
    )

  return (
    <section className="paper settings-section ai-link">
      <h2 className="section-title">{t('AI のつなぎ方')}</h2>
      <p className="muted">{t('先生との会話、ノートの評価、テストづくりなどに使う AI を、どの方法でつなぐかを選びます。')}</p>

      {option('siwc', 'Sign in with ChatGPT', t('自分の ChatGPT のプラン（Plus・Pro）の枠を使います。OpenAI の決まりで、13 歳以上の人が使えます。'), state.siwc.signedIn)}
      {state.route === 'siwc' && (
        <div className="ai-link-detail">
          {state.siwc.signedIn ? (
            <>
              <p>
                {t('サインイン中')}
                {state.siwc.email ? `（${state.siwc.email}）` : ''}。{state.siwc.planUsage ? 'Using ChatGPT plan.' : t('このアカウントでは、プランの枠を使う許可が出ていません。')}{' '}
                <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">
                  Manage usage
                </a>
              </p>
              {models.length > 0 && (
                <label>
                  {t('使うモデル')}
                  <select value={state.siwcModel} onChange={(e) => save({ siwcModel: e.target.value })}>
                    {!models.some((m) => m.slug === state.siwcModel) && <option value={state.siwcModel}>{state.siwcModel}</option>}
                    {models.map((m) => (
                      <option key={m.slug} value={m.slug}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p>
                <button className="btn" onClick={() => void api.ai.link.signOut().then(link.setData, fail)}>
                  {t('サインアウトする')}
                </button>
              </p>
            </>
          ) : (
            <p>
              <button className="btn btn-primary" onClick={signIn}>
                Continue with ChatGPT
              </button>
            </p>
          )}
        </div>
      )}

      {option(
        'own-key',
        t('自分の API キー'),
        t('Claude（Anthropic）か OpenAI の API キーを、自分で契約して入れます。キーは、この PC の中に暗号化して置き、AI の会社のほかへは送りません。使ったぶんの料金は、キーの持ち主にかかります。'),
        state.anthropicKey || state.openaiKey,
      )}
      {state.route === 'own-key' && (
        <div className="ai-link-detail">
          <label>
            <span>
              {t('Claude（Anthropic）の API キー')} {state.anthropicKey && <em data-ok>{t('設定ずみ')}</em>}
            </span>
            <input ref={anthropicKey} type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-…" />
          </label>
          <label>
            <span>
              {t('OpenAI の API キー')} {state.openaiKey && <em data-ok>{t('設定ずみ')}</em>}
            </span>
            <input ref={openaiKey} type="password" autoComplete="off" spellCheck={false} placeholder="sk-…" />
          </label>
          <p>
            <button className="btn btn-primary" onClick={saveKeys}>
              {t('キーを保存する')}
            </button>{' '}
            <button className="btn btn-quiet" onClick={() => save({ anthropicKey: '', openaiKey: '' })}>
              {t('キーを消す')}
            </button>
          </p>
          <label className="ai-link-check">
            <input type="checkbox" checked={state.routing} onChange={(e) => save({ routing: e.target.checked })} />
            <span>{t('仕事ごとに、モデルを自動で選ぶ（質問は軽いモデル、ノートの評価は上のモデル）')}</span>
          </label>
        </div>
      )}

      {option('relay', t('この PC のコマンド（開発用）'), t('この PC に入っている claude・codex のコマンドを使います。配る版には出ません。'), null)}
      {message && <p className="notice">{message}</p>}
    </section>
  )
}
