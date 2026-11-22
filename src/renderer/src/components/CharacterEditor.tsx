import { useState } from 'react'
import type { CharacterDef } from '@shared/types'
import { api, errorMessage } from '../lib/hooks'
import { Portrait } from './Portrait'
import { t } from '@/lib/i18n'

/** キャラクターの名前・性格・口調を書きかえる画面 */
export function CharacterEditor({ character, onClose }: { character: CharacterDef; onClose: () => void }) {
  const [name, setName] = useState(character.name)
  const [summary, setSummary] = useState(character.summary)
  const [persona, setPersona] = useState(character.persona)
  const [speech, setSpeech] = useState(character.speech)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await api.characters.update(character.id, { name, summary, persona, speech })
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={t('キャラクターの設定')}>
        <header className="modal-header">
          <Portrait character={character} size="md" />
          <div>
            <h2>{t('キャラクターの設定')}</h2>
            <p>{t('名前や話し方を自由に変えられます。変更すると、次の発言から反映されます。')}</p>
          </div>
        </header>
        <div className="form">
          <label>
            <span>{t('名前')}</span>
            <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span>{t('一言紹介')}</span>
            <input value={summary} maxLength={80} onChange={(e) => setSummary(e.target.value)} />
          </label>
          <label>
            <span>{t('性格・人物像')}</span>
            <textarea value={persona} rows={5} maxLength={1500} onChange={(e) => setPersona(e.target.value)} />
          </label>
          <label>
            <span>{t('話し方（口調）')}</span>
            <textarea value={speech} rows={4} maxLength={1500} onChange={(e) => setSpeech(e.target.value)} />
          </label>
        </div>
        {error && <p className="form-error">{error}</p>}
        <footer className="modal-footer">
          <button className="btn" onClick={onClose}>{t('やめる')}</button>
          <button className="btn btn-primary" disabled={saving || !name.trim()} onClick={() => void save()}>{t('保存する')}</button>
        </footer>
      </div>
    </div>
  )
}
