import { parsePicture } from '@shared/blocks'
import { api, useLoad } from '../lib/hooks'
import { t } from '@/lib/i18n'

/**
 * 挿絵（```picture）。画像はアプリのデータ置き場から読む。
 * AI が描いた絵には「イメージ」であることを、公開されている肖像画や写真には出典を、かならず添える。
 * 画像が無いときは、何も出さない（本文は、絵が無くても読めるように書かれている）。
 */
export function Picture({ source }: { source: string }) {
  const spec = parsePicture(source)
  const media = useLoad(() => (spec ? api.media.picture(spec.id) : Promise.resolve(null)), [spec?.id], ['media'])
  if (!spec || !media.data) return null
  return (
    <figure className="picture" data-kind={media.data.kind}>
      <img src={media.data.url} alt={media.data.alt || spec.caption} draggable={false} />
      <figcaption>
        {spec.caption}
        <small>
          {media.data.kind === 'generated' ? t('AI が描いたイメージです。実際とちがうところがあるかもしれません。') : t('出典: {0}', media.data.credit)}
          {media.data.kind === 'public' && media.data.source && (
            <button className="link picture-source" onClick={() => void api.attachments.open('link', media.data!.source)}>{t('もとのページを開く')}</button>
          )}
        </small>
      </figcaption>
    </figure>
  )
}
