import { t } from '@lingui/core/macro'
import { Minus, Plus } from 'lucide-react'

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
      <button
        type="button"
        title={t`Zoom out`}
        onClick={onZoomOut}
        className="flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-black/[0.04] hover:text-ink"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="w-10 text-center text-[11.5px] font-semibold text-ink">
        {zoomPercent}%
      </span>
      <button
        type="button"
        title={t`Zoom in`}
        onClick={onZoomIn}
        className="flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-black/[0.04] hover:text-ink"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <div className="mx-1 h-4 w-px bg-black/10" />
      <button
        type="button"
        onClick={onFitView}
        className="px-1 text-[11px] font-semibold text-accent hover:underline"
      >
        {t`Fit`}
      </button>
    </div>
  )
}
