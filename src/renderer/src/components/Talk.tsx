import type { ReactNode } from 'react'
import { parseTalk } from '@shared/talk'
import type { MediaInfo } from '@shared/types'
import { api, useLoad } from '../lib/hooks'
import { Portrait } from './Portrait'
import { t, tx } from '@/lib/i18n'

/**
 * 掛け合い（```talk）。先生と同級生が、顔と吹き出しで話す。
 * 登場人物に無い名前（歴史上の人物など）は、絵が用意されていればその絵で、無ければ名前の 1 文字目の札で表す。
 * render は、せりふ（数式や太字をふくむ）を描く関数。
 */
export function Talk({ source, render }: { source: string; render: (text: string) => ReactNode }) {
  const characters = useLoad(() => api.characters.list(), [], ['characters'])
  // 歴史上の人物の名前の訳（本文の話し手は、絵を引くために日本語の名前のままにしてある）
  const names = useLoad(() => api.content.personNames(), [], ['content'])
  const shownName = (speaker: string) => names.data?.[speaker] ?? speaker
  const lines = parseTalk(source)
  const find = (speaker: string) => characters.data?.find((c) => c.id === speaker || c.name === speaker || c.name.replace(/\s/g, '') === speaker)
  const speakers = [...new Set(lines.map((l) => l.speaker))]
  const guests = characters.data ? speakers.filter((s) => !find(s)) : []
  // 歴史上の人物などの絵（あれば）
  const faces = useLoad(
    async () => Object.fromEntries(await Promise.all(guests.map(async (name) => [name, await api.media.person(name)] as const))) as Record<string, MediaInfo | null>,
    [guests.join('\n')],
    ['media'],
  )
  if (!lines.length || !characters.data) return null

  // 先生は左。ほかの人は、出てきた順に 右・左・右… と並べる
  const order = [...speakers.filter((s) => find(s)?.role === 'teacher'), ...speakers.filter((s) => find(s)?.role !== 'teacher')]
  const shown = guests.map((name) => faces.data?.[name]).filter((face): face is MediaInfo => !!face)
  const credits = [...new Set(shown.filter((face) => face.kind === 'public' && face.credit).map((face) => face.credit))]

  return (
    <div className="kakeai" role="group" aria-label={t('掛け合い')}>
      {lines.map((line, i) => {
        const character = find(line.speaker)
        const face = faces.data?.[line.speaker]
        return (
          <div key={i} className="kakeai-line" data-side={order.indexOf(line.speaker) % 2 === 0 ? 'left' : 'right'}>
            {character ? (
              <Portrait character={character} expression={line.expression} size="md" />
            ) : face ? (
              <span className="portrait portrait-md kakeai-guest">
                <img src={face.url} alt={t('{0}の絵', shownName(line.speaker))} draggable={false} />
              </span>
            ) : (
              <span className="kakeai-badge" aria-hidden>
                {[...shownName(line.speaker)][0]}
              </span>
            )}
            <div className="kakeai-say">
              <small>{character ? character.name : shownName(line.speaker)}</small>
              <div className="bubble kakeai-bubble">{render(line.text)}</div>
            </div>
          </div>
        )
      })}
      {guests.length > 0 && (
        <p className="kakeai-note">{tx('※ 歴史上の人物などのせりふは、授業の内容をもとに想像して書いたものです。本人の言葉ではありません。{0}{1}', shown.some((face) => face.kind === 'generated') && t('絵も、AI が描いたイメージです。'), credits.length > 0 && t('絵の出典: {0}', credits.join('、')))}
        </p>
      )}
    </div>
  )
}
