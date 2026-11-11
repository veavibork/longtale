import { useState } from 'react'
import { usePrompts } from '../hooks/use-prompts'
import './PromptsView.css'

/** Per-user override editing still isn't built. */
export default function PromptsView() {
  const { data: prompts, isLoading } = usePrompts()
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (isLoading || !prompts) return <div className="prompts-view">Loading…</div>

  const needle = filter.trim().toLowerCase()
  const filtered = needle
    ? prompts.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          p.usedBy.toLowerCase().includes(needle) ||
          p.sourceFile.toLowerCase().includes(needle) ||
          p.content.toLowerCase().includes(needle),
      )
    : prompts

  return (
    <div className="prompts-view">
      <h2>Prompts</h2>
      <p className="prompts-note">
        Every system prompt and instruction the agents run on, read-only. Templates are shown with
        sample values; the real ones are filled in per job.
      </p>

      <input
        className="prompts-filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by name, agent, file, or content…"
      />

      <div className="prompt-list">
        {filtered.map((p) => {
          const isOpen = expanded.has(p.id)
          return (
            <div key={p.id} className="prompt-entry">
              <button type="button" className="prompt-entry-header" onClick={() => toggle(p.id)}>
                <span className="prompt-caret">{isOpen ? '▾' : '▸'}</span>
                <span className="prompt-name">{p.name}</span>
                <span className="prompt-kind">{p.kind}</span>
                <span className="prompt-used-by">{p.usedBy}</span>
              </button>
              <div className="prompt-source">{p.sourceFile}</div>
              {isOpen && <pre className="prompt-content">{p.content}</pre>}
            </div>
          )
        })}
        {filtered.length === 0 && <p className="prompts-empty">No prompts match "{filter}".</p>}
      </div>
    </div>
  )
}
