import { useEffect, useState } from 'react'
import { penStats, resetPenStats, type PenStats } from './penStats'
import { t, tx } from '@/lib/i18n'

const TYPE_LABEL: Record<string, string> = { pen: t('ペン'), mouse: t('マウス'), touch: t('指（タッチ）'), '': '—' }

function verdict(stats: PenStats): { kind: 'ok' | 'warn' | 'wait'; text: string } {
  if (!stats.penSeen) {
    return { kind: 'wait', text: t('まだペンの入力がありません。ペンでノートに線を引いてみてください。') }
  }
  if (stats.maxPressure === 0) {
    return { kind: 'wait', text: t('ペンを認識しました。強さを変えながら、何本か線を引いてみてください。') }
  }
  if (stats.maxPressure - stats.minPressure < 0.15) {
    return {
      kind: 'warn',
      text: t('ペンは認識されていますが、筆圧がほとんど変化していません。強く・弱く書いても変わらない場合は、タブレットのドライバー設定で「Windows Ink」を有効にしてください。'),
    }
  }
  return { kind: 'ok', text: t('筆圧を検知できています。強く書くと太く、弱く書くと細くなります。') }
}

/** ペンタブレットの入力が正しく届いているかを確かめるパネル */
export function PenDiagnostics() {
  const [stats, setStats] = useState<PenStats>({ ...penStats })

  useEffect(() => {
    const timer = window.setInterval(() => setStats({ ...penStats }), 150)
    return () => window.clearInterval(timer)
  }, [])

  const result = verdict(stats)
  const range = stats.maxPressure > 0 ? `${Math.round(stats.minPressure * 100)}% 〜 ${Math.round(stats.maxPressure * 100)}%` : '—'

  return (
    <div className="pen-diag">
      <p className="pen-diag-verdict" data-kind={result.kind}>
        {result.text}
      </p>
      <dl>
        <dt>{t('入力の種類')}</dt>
        <dd>{TYPE_LABEL[stats.pointerType] ?? stats.pointerType}</dd>
        <dt>{t('いまの筆圧')}</dt>
        <dd>
          <span className="meter">
            <i style={{ width: `${Math.round(stats.pressure * 100)}%` }} />
          </span>
          <span className="meter-value">{Math.round(stats.pressure * 100)}%</span>
        </dd>
        <dt>{t('筆圧の幅')}</dt>
        <dd>{range}</dd>
        <dt>{t('ペンの傾き')}</dt>
        <dd>{tx('左右 {0}° ／ 前後 {1}°', stats.tiltX, stats.tiltY)}</dd>
        <dt>{t('座標の取得')}</dt>
        <dd>{tx('{0} 回 / 秒', stats.rate)}</dd>
        <dt>{t('書いた線')}</dt>
        <dd>{tx('{0} 本', stats.strokes)}</dd>
        <dt>{t('消しゴム側')}</dt>
        <dd>{stats.eraserSeen ? t('認識しました') : '—'}</dd>
      </dl>
      <p className="muted">{t('座標の取得回数は、直前に引いた線での 1 秒あたりの数です。100 回 / 秒を超えていれば、速く書いてもなめらかな線になります。 傾きは、対応しているペンだけ表示されます。')}</p>
      <button className="btn btn-quiet" onClick={() => resetPenStats()}>{t('記録をやり直す')}</button>
    </div>
  )
}
