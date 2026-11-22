import { AiLink } from '../components/AiLink'
import { useEffect, useState } from 'react'
import { LANGUAGES, type Lang } from '@shared/i18n'
import { KEY_ACTIONS, ZOOM_MAX, ZOOM_MIN, combo, isModifierCode, resolveKeys } from '@shared/keys'
import type { ViewName } from '@shared/types'
import { api, errorMessage, useLoad } from '../lib/hooks'
import { useComboLabel } from '../lib/keys'
import { getLang, t, tx } from '@/lib/i18n'

const ALL_VIEW_LABELS: [ViewName, string][] = [
  ['home', t('ホーム')],
  ['textbook', t('教科書')],
  ['chat', t('チャット')],
  ['note', t('ノート')],
  ['memo', t('メモ')],
  ['glossary', t('用語集')],
  ['search', t('検索')],
  ['timeline', t('年表')],
  ['essay', t('記述・論述の練習')],
  ['test', t('テスト')],
  ['report', t('成績')],
  ['debate', t('ディベート')],
  ['eikaiwa', t('英会話')],
  ['vocab', t('語彙力特訓')],
  ['kanji', t('漢字特訓（漢字）')],
  ['kanjiOrder', t('漢字特訓（書き順）')],
  ['kanjiNote', t('漢字特訓（ノート）')],
  ['library', t('教材づくり')],
  ['settings', t('設定')],
]
/** 教材づくりの画面は、開発用の版だけ */
const VIEW_LABELS = ALL_VIEW_LABELS.filter(([view]) => view !== 'library' || api.authoring)

const GROUPS = [
  { id: 'all', title: t('すべての画面') },
  { id: 'note', title: t('ノート') },
] as const

/** 設定の画面。画面ごとの表示倍率と、ショートカットキーの割り当てを変える。 */
export function Settings() {
  const settings = useLoad(() => api.settings.get(), [], ['settings', 'zoom'])
  const label = useComboLabel()
  /** いま割り当てを変えている操作 */
  const [capturing, setCapturing] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** 切りかえようとしている言語（確かめの表示を出している間） */
  const [nextLang, setNextLang] = useState<Lang | null>(null)
  const [langError, setLangError] = useState<string | null>(null)
  const switchLanguage = async (language: Lang) => {
    setLangError(null)
    try {
      await api.settings.set({ language })
    } catch (e) {
      setLangError(errorMessage(e))
      setNextLang(null)
    }
  }
  const overrides = settings.data?.keys ?? {}
  const keys = resolveKeys(overrides)

  // 「変更」を押したあと、次に押されたキーの組み合わせを割り当てる
  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (isModifierCode(e.code)) return
      if (e.code === 'Escape') return setCapturing(null)
      const value = combo(e, e.code)
      const action = KEY_ACTIONS.find((a) => a.id === capturing)!
      // 同じ場面で使う別の操作に、同じ組み合わせがあれば、そちらの割り当てを外す
      const clash = KEY_ACTIONS.find((a) => a.id !== action.id && keys[a.id] === value && (a.group === action.group || a.group === 'all' || action.group === 'all'))
      void api.settings.set({ keys: { ...overrides, [action.id]: value, ...(clash ? { [clash.id]: '' } : {}) } })
      setNotice(clash ? t('「{0}」と同じ組み合わせだったので、そちらの割り当てを外しました。', clash.label) : null)
      setCapturing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, keys, overrides])

  if (!settings.data) return null
  const zoom = settings.data.zoom ?? {}
  const percent = (view: ViewName) => Math.round((zoom[view] ?? 1) * 100)
  const setZoom = (view: ViewName, value: number) => void api.zoom.set(view, value / 100)
  const setAllZoom = (value: number) => VIEW_LABELS.forEach(([view]) => setZoom(view, value))
  const same = VIEW_LABELS.every(([view]) => percent(view) === percent('home'))
  const assign = (id: string, value: string | undefined) => {
    const next = { ...overrides }
    if (value === undefined) delete next[id]
    else next[id] = value
    void api.settings.set({ keys: next })
    setNotice(null)
  }

  return (
    <div className="test settings">
      <header className="view-header" data-mode="textbook">
        <div className="view-header-title">
          <small>{t('学びアイ')}</small>
          <strong>{t('設定')}</strong>
        </div>
      </header>
      <div className="test-scroll">
        <section className="paper settings-section">
          {/* 言語の名前は、どの言語で表示していても読めるように、その言語での呼び名で出す */}
          <h2 className="section-title">{getLang() === 'ja' ? '言語（Language）' : 'Language（言語）'}</h2>
          <p className="muted">{t('画面の文言と教材、AI の返事を、選んだ言語にします。切りかえると、アプリを開き直します（開いているウィンドウは、いったんすべて閉じます）。')}</p>
          <div className="segmented settings-language" role="group" aria-label="Language">
            {LANGUAGES.map((language) => (
              <button key={language.id} lang={language.id} aria-pressed={getLang() === language.id} disabled={nextLang !== null} onClick={() => language.id !== getLang() && setNextLang(language.id)}>
                {language.label}
              </button>
            ))}
          </div>
          {nextLang && (
            <p className="notice settings-language-confirm">
              {tx('表示を「{0}」に切りかえて、アプリを開き直します。よろしいですか？', LANGUAGES.find((l) => l.id === nextLang)?.label)}{' '}
              <button className="btn btn-primary" onClick={() => void switchLanguage(nextLang)}>
                {t('切りかえる')}
              </button>{' '}
              <button className="btn btn-quiet" onClick={() => setNextLang(null)}>
                {t('やめる')}
              </button>
            </p>
          )}
          {langError && <p className="form-error">{langError}</p>}
          {getLang() !== 'ja' && <p className="muted">{t('教材は、日本語の原本を訳したものです。まだ訳されていない授業は、日本語のまま表示します。授業の作成（教材づくり）は、日本語で表示しているときに行います。')}</p>}
        </section>

        <AiLink />

        <section className="paper settings-section">
          <h2 className="section-title">{t('教科書のふりがな')}</h2>
          <p className="muted">{t('教科書で、人や土地の名前、むずかしい言葉、まだ習っていない漢字の言葉に、ふりがなを出します（用語とふりがなのデータがある授業だけ）。教科書の画面の上の「ふりがな」でも切りかえられます。')}</p>
          <div className="segmented settings-choice" role="group" aria-label={t('教科書のふりがな')}>
            <button aria-pressed={settings.data.furigana !== false} onClick={() => void api.settings.set({ furigana: true })}>{t('出す')}</button>
            <button aria-pressed={settings.data.furigana === false} onClick={() => void api.settings.set({ furigana: false })}>{t('出さない')}</button>
          </div>
        </section>

        <section className="paper settings-section">
          <h2 className="section-title">{t('利き手')}</h2>
          <p className="muted">{t('書くほうの手を選びます。教科書といっしょに開くノートと、ノートの道具の列が、利き手の側に出ます。')}</p>
          <div className="segmented settings-choice" role="group" aria-label={t('利き手')}>
            <button aria-pressed={settings.data.handedness !== 'left'} onClick={() => void api.settings.set({ handedness: 'right' })}>{t('右利き')}</button>
            <button aria-pressed={settings.data.handedness === 'left'} onClick={() => void api.settings.set({ handedness: 'left' })}>{t('左利き')}</button>
          </div>
        </section>

        <section className="paper settings-section">
          <h2 className="section-title">{t('画面の表示倍率')}</h2>
          <p className="muted">{tx('画面ごとに、100%〜400% の間で変えられます。どの画面でも、{0} で大きく、{1} で小さく、{2} で 100% にもどせます（Ctrl を押しながらマウスのホイールを回しても変えられます）。', label(keys['zoomIn']), label(keys['zoomOut']), label(keys['zoomReset']))}</p>
          <ul className="zoom-list">
            <li className="zoom-all">
              <strong>{t('すべての画面')}</strong>
              <input
                type="range"
                min={ZOOM_MIN * 100}
                max={ZOOM_MAX * 100}
                step={10}
                value={same ? percent('home') : 100}
                aria-label={t('すべての画面の表示倍率')}
                onChange={(e) => setAllZoom(Number(e.target.value))}
              />
              <b>{same ? `${percent('home')}%` : t('画面ごと')}</b>
              <button className="btn btn-quiet" disabled={same && percent('home') === 100} onClick={() => setAllZoom(100)}>{t('すべて 100%')}</button>
            </li>
            {VIEW_LABELS.map(([view, name]) => (
              <li key={view}>
                <span>{name}</span>
                <input
                  type="range"
                  min={ZOOM_MIN * 100}
                  max={ZOOM_MAX * 100}
                  step={10}
                  value={percent(view)}
                  aria-label={t('{0}の表示倍率', name)}
                  onChange={(e) => setZoom(view, Number(e.target.value))}
                />
                <b>{percent(view)}%</b>
                <button className="btn btn-quiet" disabled={percent(view) === 100} onClick={() => setZoom(view, 100)}>
                  100%
                </button>
              </li>
            ))}
          </ul>
          <p className="muted">{t('ノートのページだけを大きくしたいときは、ノートの右下の拡大率か、下のショートカット（押している間にドラッグ）を使います。')}</p>
        </section>

        <section className="paper settings-section">
          <h2 className="section-title">{t('ショートカットキー')}</h2>
          <p className="muted">{t('「変更」を押してから、使いたいキーを押します（Ctrl・Shift・Alt と組み合わせられます。Esc でやめます）。文字を入力している間は、Ctrl や Alt を使わないショートカットは働きません。')}</p>
          {notice && <p className="notice">{notice}</p>}
          {GROUPS.map((group) => (
            <div key={group.id}>
              <h3 className="settings-group">{group.title}</h3>
              <ul className="key-list">
                {KEY_ACTIONS.filter((a) => a.group === group.id).map((action) => (
                  <li key={action.id} data-capturing={capturing === action.id}>
                    <span>{action.label}</span>
                    <kbd data-empty={!keys[action.id]}>{capturing === action.id ? t('キーを押してください…') : label(keys[action.id])}</kbd>
                    <button className="btn" onClick={() => setCapturing(capturing === action.id ? null : action.id)}>
                      {capturing === action.id ? t('やめる') : t('変更')}
                    </button>
                    <button className="btn btn-quiet" disabled={!keys[action.id]} onClick={() => assign(action.id, '')}>{t('外す')}</button>
                    <button className="btn btn-quiet" disabled={!(action.id in overrides)} onClick={() => assign(action.id, undefined)}>{t('はじめにもどす')}</button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="muted">{t('ノートで範囲を選んでいるときは、Delete キーで、その範囲だけを消します（この割り当ては変えられません）。')}</p>
        </section>
      </div>
    </div>
  )
}
