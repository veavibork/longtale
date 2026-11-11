import { memo, type ReactNode } from 'react'
import { WORLDBOOK_BLOCK_PATTERN } from '../lib/worldbookBlocks'

/** Renders post content pre-wrapped with inline bold/italic only, so read mode matches the edit textarea. */
const INLINE_PATTERN = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g

/** `base` is this run's starting offset in the *original* source string (not the rendered text) */
function renderInline(text: string, keyPrefix: string, base: number): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  for (const match of text.matchAll(INLINE_PATTERN)) {
    if (match.index! > lastIndex) {
      nodes.push(
        <span key={`${keyPrefix}-t${lastIndex}`} data-src-start={base + lastIndex}>
          {text.slice(lastIndex, match.index)}
        </span>,
      )
    }
    if (match[1] !== undefined) {
      nodes.push(
        <strong
          key={`${keyPrefix}-${match.index}`}
          data-src-start={base + match.index! + 2 /* skip opening "**" */}
        >
          {match[1]}
        </strong>,
      )
    } else {
      nodes.push(
        <em
          key={`${keyPrefix}-${match.index}`}
          data-src-start={base + match.index! + 1 /* skip opening "*" */}
        >
          {match[2]}
        </em>,
      )
    }
    lastIndex = match.index! + match[0].length
  }
  if (lastIndex < text.length) {
    nodes.push(
      <span key={`${keyPrefix}-t${lastIndex}`} data-src-start={base + lastIndex}>
        {text.slice(lastIndex)}
      </span>,
    )
  }
  return nodes
}

function EntryContent({
  content,
  highlightBlocks,
}: {
  content: string
  highlightBlocks?: boolean
}) {
  if (!highlightBlocks) {
    return <div className="entry-content">{renderInline(content, 'i', 0)}</div>
  }

  const segments: { text: string; type: string | null; start: number }[] = []
  let lastIndex = 0
  for (const match of content.matchAll(WORLDBOOK_BLOCK_PATTERN)) {
    if (match.index! > lastIndex)
      segments.push({ text: content.slice(lastIndex, match.index), type: null, start: lastIndex })
    segments.push({ text: match[0], type: match[1].toLowerCase(), start: match.index! })
    lastIndex = match.index! + match[0].length
  }
  if (lastIndex < content.length)
    segments.push({ text: content.slice(lastIndex), type: null, start: lastIndex })

  return (
    <div className="entry-content">
      {segments.map((seg, i) =>
        seg.type ? (
          <mark key={i} className={`worldbook-block worldbook-block-${seg.type}`}>
            {renderInline(seg.text, `m${i}`, seg.start)}
          </mark>
        ) : (
          <span key={i}>{renderInline(seg.text, `s${i}`, seg.start)}</span>
        ),
      )}
    </div>
  )
}

// StoryView re-renders the whole log on every streamed token (pendingReplies changes) or click.
export default memo(EntryContent)
