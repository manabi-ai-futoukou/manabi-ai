import { useMemo, useState } from 'react'
import type { TimelineData } from '@shared/types'
import { PinButton } from '../components/PinButton'
import { api, useLoad } from '../lib/hooks'
import { getLang, t, tx } from '@/lib/i18n'

type Event = TimelineData['events'][number]
type Mode = 'japan' | 'world' | 'both'

/** 日本史の時代の区切り（はじまりの年。教科書でふつうに使われる区切り） */
const JAPAN_ERAS: [number, string][] = [
  [-Infinity, t('旧石器時代')],
  [-13000, t('縄文時代')],
  [-400, t('弥生時代')],
  [250, t('古墳時代')],
  [592, t('飛鳥時代')],
  [710, t('奈良時代')],
  [794, t('平安時代')],
  [1185, t('鎌倉時代')],
  [1333, t('室町時代（南北朝・戦国をふくむ）')],
  [1573, t('安土桃山時代')],
  [1603, t('江戸時代')],
  [1868, t('明治時代')],
  [1912, t('大正時代')],
  [1926, t('昭和時代')],
  [1989, t('平成時代')],
  [2019, t('令和時代')],
]
/** 世界史のまとまり（はじまりの年） */
const WORLD_ERAS: [number, string][] = [
  [-Infinity, t('人類のはじまり・古代文明（〜紀元前 6 世紀）')],
  [-500, t('紀元前 5 世紀〜紀元前 1 世紀')],
  [1, t('1〜5 世紀')],
  [501, t('6〜10 世紀')],
  [1001, t('11〜13 世紀')],
  [1301, t('14〜15 世紀')],
  [1501, t('16 世紀')],
  [1601, t('17 世紀')],
  [1701, t('18 世紀')],
  [1801, t('19 世紀')],
  [1901, t('20 世紀（〜1945 年）')],
  [1946, t('20 世紀（1946 年〜）')],
  [2001, t('21 世紀')],
]
const eraIndex = (eras: [number, string][], year: number) => {
  let at = 0
  eras.forEach(([from], i) => {
    if (year >= from) at = i
  })
  return at
}

/**
 * 年表モード。日本史と世界史のできごとを、年の順に並べる。「並べて見る」では、同じ時期の日本と世界を横に並べる。
 * できごとは、歴史の授業（中学 歴史、高校 歴史総合・日本史探究・世界史探究、小学 6 年 社会）の本文から AI が抜き出したもの。
 * できごとから、それを学ぶ授業（教科書）を開ける。
 */
export function Timeline() {
  const timeline = useLoad(() => api.annot.timeline(), [], ['annot'])
  const [mode, setMode] = useState<Mode>('japan')
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState('')

  const events = useMemo(() => {
    const word = query.trim().toLowerCase()
    return (timeline.data?.events ?? []).filter((e) => {
      if (level && !e.lessons.some((key) => key.startsWith(level))) return false
      return !word || `${e.label}${e.note}${e.yearLabel}`.toLowerCase().includes(word)
    })
  }, [timeline.data, query, level])

  if (getLang() !== 'ja') return <p className="view-error">{t('年表は、日本語で表示しているときに使えます。')}</p>

  const item = (e: Event, i: number) => (
    <li key={`${e.year}:${e.label}:${i}`} className="timeline-event" data-region={e.region}>
      <span className="timeline-year">{e.yearLabel}</span>
      <div>
        <strong>{e.label}</strong>
        {e.note && <p>{e.note}</p>}
        <div className="timeline-lessons">
          {e.lessons.slice(0, 4).map((key) => {
            const lesson = timeline.data?.lessons[key]
            return lesson ? (
              <button key={key} className="btn btn-quiet" title={t('この授業を、教科書で開く')} onClick={() => void api.view.open('textbook', { lessonId: lesson.lessonId, variant: lesson.variant })}>
                {lesson.courseTitle} {lesson.number} {lesson.title}
              </button>
            ) : null
          })}
        </div>
      </div>
    </li>
  )
  const sections = (region: 'japan' | 'world') => {
    const eras = region === 'japan' ? JAPAN_ERAS : WORLD_ERAS
    const list = events.filter((e) => e.region === region)
    return eras.map(([, label], index) => {
      const inEra = list.filter((e) => eraIndex(eras, e.year) === index)
      return inEra.length ? (
        <section key={label} className="timeline-era">
          <h2>{label}<small>{tx('{0} 件', inEra.length)}</small></h2>
          <ol>{inEra.map(item)}</ol>
        </section>
      ) : null
    })
  }

  return (
    <div className="timeline">
      <header className="view-header" data-mode="textbook">
        <div className="view-header-title">
          <small>{t('日本史と世界史')}</small>
          <strong>{t('年表')}</strong>
        </div>
        <div className="view-header-actions">
          <div className="segmented" role="group" aria-label={t('年表の種類')}>
            <button aria-pressed={mode === 'japan'} onClick={() => setMode('japan')}>{t('日本史')}</button>
            <button aria-pressed={mode === 'world'} onClick={() => setMode('world')}>{t('世界史')}</button>
            <button aria-pressed={mode === 'both'} onClick={() => setMode('both')}>{t('並べて見る')}</button>
          </div>
          <PinButton className="btn btn-quiet" />
        </div>
      </header>

      <div className="timeline-body">
        <div className="timeline-tools">
          <input type="search" value={query} placeholder={t('できごとを探す（例: 幕府、革命、条約）')} aria-label={t('できごとを探す')} onChange={(e) => setQuery(e.target.value)} />
          <select value={level} aria-label={t('授業の段階')} onChange={(e) => setLevel(e.target.value)}>
            <option value="">{t('すべての授業のできごと')}</option>
            <option value="es">{t('小学校の授業に出てくるもの')}</option>
            <option value="jhs">{t('中学校の授業に出てくるもの')}</option>
            <option value="hs">{t('高校の授業に出てくるもの')}</option>
          </select>
          <span className="muted">{tx('{0} 件', events.filter((e) => mode === 'both' || e.region === mode).length.toLocaleString())}</span>
        </div>

        {timeline.data === null || (timeline.data && !timeline.data.events.length) ? (
          <p className="card muted">{t('年表のデータが、まだありません。歴史の授業の「用語とふりがな」を用意すると（教科書の画面、または、まとめて作る道具）、できごとがここに並びます。')}</p>
        ) : mode === 'both' ? (
          <div className="timeline-both">
            <div className="timeline-both-head">
              <span />
              <strong>{t('日本')}</strong>
              <strong>{t('世界')}</strong>
            </div>
            {JAPAN_ERAS.map(([, label], index) => {
              const inEra = events.filter((e) => eraIndex(JAPAN_ERAS, e.year) === index)
              return inEra.length ? (
                <section key={label} className="timeline-both-row">
                  <h2>{label}</h2>
                  <ol>{inEra.filter((e) => e.region === 'japan').map(item)}</ol>
                  <ol>{inEra.filter((e) => e.region === 'world').map(item)}</ol>
                </section>
              ) : null
            })}
          </div>
        ) : (
          <div className="timeline-single">{sections(mode)}</div>
        )}
        <p className="notice">{t('年表は、AI が授業の本文から抜き出したできごとをまとめたものです。人の目による確認は、まだ行われていません。年やできごとは、教科書の本文で確かめてください。')}</p>
      </div>
    </div>
  )
}
