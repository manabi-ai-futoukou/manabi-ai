import type { CharacterDef } from '@shared/types'
import { t } from '@/lib/i18n'

/** 開発時（http）でも配布時（file）でも読めるよう、相対パスで指定する */
export function characterImage(character: CharacterDef, expression?: string): string {
  const file = character.expressions[expression ?? ''] ?? character.expressions[character.defaultExpression]
  return `./characters/${character.id}/${file}`
}

/**
 * キャラクターの顔。切り抜き画像は髪のすき間などに白が残るので、白い台紙の上に置く。
 */
export function Portrait({
  character,
  expression,
  size = 'md',
}: {
  character: CharacterDef
  expression?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  return (
    <span className={`portrait portrait-${size}`} data-role={character.role}>
      <img src={characterImage(character, expression)} alt={t('{0}の表情', character.name)} draggable={false} />
    </span>
  )
}
