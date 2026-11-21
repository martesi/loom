import { t } from '@lingui/core/macro'
import { Maximize2, Minus, Plus } from 'lucide-react'
import { Tooltip } from '../ui/tooltip'

interface ZoomControlsProps {
  zoomPercent: number
  onZoomIn: () => void
  onZoomOut: () => void
  onFitView: () => void
}

export function ZoomControls({
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onFitView,
}: ZoomControlsProps) {
  return (
    <div className="absolute bottom-4 right-4 z-10 flex items-center gap-0.5 rounded-md border border-black/8 bg-white/92 px-1.5 py-1 shadow-md backdrop-blur-sm">
      <Tooltip label={t`Zoom out`}>
        <button
          type="button"
          aria-label={t`Zoom out`}
          onClick={onZoomOut}
          className="flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-black/[0.04] hover:text-ink"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
      <span className="w-10 text-center text-[11.5px] font-semibold text-ink">
        {zoomPercent}%
      </span>
      <Tooltip label={t`Zoom in`}>
        <button
          type="button"
          aria-label={t`Zoom in`}
          onClick={onZoomIn}
          className="flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-black/[0.04] hover:text-ink"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
      <div className="mx-1 h-4 w-px bg-black/10" />
      <Tooltip label={t`Fit`}>
        <button
          type="button"
          aria-label={t`Fit`}
          onClick={onFitView}
          className="flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-black/[0.04] hover:text-ink"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
    </div>
  )
}
