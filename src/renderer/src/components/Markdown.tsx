import { Children, isValidElement, memo, useContext, useMemo, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { AnnotationContext, rehypeAnnotate } from '../lib/annotateText'
import { Figure, Plot } from './Figures'
import { NumberLine } from './NumberLine'
import { Picture } from './Picture'
import { Sim } from './Sim'
import { Talk } from './Talk'

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children)
  return ''
}

/** ```numberline・```plot・```figure のコードブロックは、コードではなく図として描く。```talk は掛け合い、```sim は動く図解、```picture は挿絵として描く */
function Pre({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children)[0]
  if (isValidElement(child)) {
    const props = (child as ReactElement<{ className?: string; children?: ReactNode }>).props
    if (props.className?.includes('language-numberline')) return <NumberLine source={textOf(props.children)} />
    if (props.className?.includes('language-plot')) return <Plot source={textOf(props.children)} />
    if (props.className?.includes('language-figure')) return <Figure source={textOf(props.children)} />
    if (props.className?.includes('language-talk')) return <Talk source={textOf(props.children)} render={(text) => <Markdown>{text}</Markdown>} />
    if (props.className?.includes('language-sim')) return <Sim source={textOf(props.children)} render={(text) => <Markdown>{text}</Markdown>} />
    if (props.className?.includes('language-picture')) return <Picture source={textOf(props.children)} />
  }
  return <pre>{children}</pre>
}

/**
 * 教科書の本文や AI の返答（Markdown + 数式）を表示する。
 * HTML はそのまま描画しないので、AI が生成した文章を表示しても安全。
 */
export const Markdown = memo(function Markdown({ children, className }: { children: string; className?: string }) {
  // 教科書の本文では、ふりがなと用語の目印を付ける（数式に変える前に行う。数式の中は、さわらない）
  const annotation = useContext(AnnotationContext)
  const rehypePlugins = useMemo(() => (annotation ? [rehypeAnnotate(annotation), rehypeKatex] : [rehypeKatex]), [annotation])
  return (
    <div className={`md ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={rehypePlugins} components={{ pre: Pre }}>
        {children}
      </ReactMarkdown>
    </div>
  )
})
