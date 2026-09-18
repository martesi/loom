import { useEffect, useState } from 'react'
import { pluginHost } from '../lib/plugin-host'

export function OperationWorkspace() {
  const operations = pluginHost.context.operations
  const [activeId, setActiveId] = useState(operations.activeId)

  useEffect(() => operations.subscribe(setActiveId), [operations])

  if (!activeId) return null
  const operation = operations.get(activeId)
  const contributions = pluginHost.context.ui.list('operation.workspace')

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={operation?.title ?? 'Operation'}
        className="w-full max-w-lg rounded-lg border border-black/10 bg-card p-4 shadow-xl"
      >
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">
            {operation?.title ?? activeId}
          </h2>
          <button
            type="button"
            aria-label="Close operation"
            className="rounded-sm px-2 py-1 text-xs text-ink-muted hover:bg-black/[0.04]"
            onClick={() => operations.close()}
          >
            Close
          </button>
        </header>
        {contributions.map((contribution) => (
          <div key={contribution.id}>
            {contribution.render({ operationId: activeId })}
          </div>
        ))}
      </section>
    </div>
  )
}
