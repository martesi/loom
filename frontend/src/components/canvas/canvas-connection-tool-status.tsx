import { t } from '@lingui/core/macro'
import type { CanvasConnectionTool } from './use-canvas-workspace-state'

export function CanvasConnectionToolStatus({
  tool,
  anchorName,
  onExit,
}: {
  tool: Exclude<CanvasConnectionTool, null>
  anchorName?: string | number
  onExit: () => void
}) {
  return (
    <div
      role="status"
      data-testid="connection-tool-status"
      className="absolute left-1/2 top-14 z-20 flex -translate-x-1/2 items-center gap-3 rounded-md border border-border bg-card/95 px-3 py-2 text-xs font-medium text-ink shadow-lg"
    >
      <span>
        {tool === 'connect-derivative'
          ? t`Connect source → derivative`
          : tool === 'connect-source'
            ? t`Connect source ← selected image`
            : t`Click a relationship to reverse it`}
        {tool !== 'reverse-relationship' &&
          anchorName !== undefined &&
          ` · ${anchorName}`}
      </span>
      <button
        type="button"
        aria-label={t`Exit connection mode`}
        data-testid="exit-connection-tool"
        onClick={onExit}
        className="rounded px-2 py-1 text-ink-muted hover:bg-accent hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {t`Exit · Esc`}
      </button>
    </div>
  )
}
