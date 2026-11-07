import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'

export interface ShelfPanelProps {
  title: string
  side: 'left' | 'right'
  open: boolean
  onOpenChange: (open: boolean) => void
  shortcutHint?: string
  children: React.ReactNode
  width?: number
  minWidth?: number
  maxWidth?: number
}

const DEFAULT_WIDTH = 320
const DEFAULT_MIN_WIDTH = 240
const DEFAULT_MAX_WIDTH = 480

export function ShelfPanel({
  title,
  side,
  open,
  onOpenChange,
  shortcutHint,
  children,
  width = DEFAULT_WIDTH,
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth = DEFAULT_MAX_WIDTH,
}: ShelfPanelProps) {
  const [panelWidth, setPanelWidth] = useState(width)
  const [isResizing, setIsResizing] = useState(false)
  const asideRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (width !== undefined) {
      setPanelWidth(width)
    }
  }, [width])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      setIsResizing(true)
      const startX = e.clientX
      const startWidth = panelWidth
      const target = e.currentTarget
      try {
        target.setPointerCapture(e.pointerId)
      } catch {}

      const onPointerMove = (ev: PointerEvent) => {
        const delta = ev.clientX - startX
        const nextWidth =
          side === 'left' ? startWidth + delta : startWidth - delta
        const clamped = Math.min(maxWidth, Math.max(minWidth, nextWidth))
        setPanelWidth(clamped)
      }

      const onPointerUp = (ev: PointerEvent) => {
        try {
          target.releasePointerCapture(ev.pointerId)
        } catch {}
        setIsResizing(false)
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', onPointerUp)
      }

      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
    },
    [side, minWidth, maxWidth, panelWidth]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = 8 // 8pt grid
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        const delta = side === 'left' ? -step : step
        setPanelWidth((prev) =>
          Math.min(maxWidth, Math.max(minWidth, prev + delta))
        )
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        const delta = side === 'left' ? step : -step
        setPanelWidth((prev) =>
          Math.min(maxWidth, Math.max(minWidth, prev + delta))
        )
      } else if (e.key === 'Home') {
        e.preventDefault()
        setPanelWidth(minWidth)
      } else if (e.key === 'End') {
        e.preventDefault()
        setPanelWidth(maxWidth)
      }
    },
    [side, minWidth, maxWidth]
  )

  return (
    <>
      <aside
        ref={asideRef}
        aria-label={title}
        aria-hidden={!open}
        data-state={open ? 'open' : 'closed'}
        data-side={side}
        className={cn(
          'relative flex shrink-0 flex-col bg-card select-none',
          !isResizing && 'transition-[width,transform] duration-200 ease-out',
          side === 'left'
            ? 'border-r border-black/10'
            : 'border-l border-black/10',
          'max-[1099px]:absolute max-[1099px]:inset-y-0 max-[1099px]:z-30 max-[1099px]:shadow-2xl max-[1099px]:border-x',
          side === 'left' ? 'max-[1099px]:left-0' : 'max-[1099px]:right-0',
          !open &&
            'w-0 min-w-0 max-w-0 overflow-hidden border-0 pointer-events-none'
        )}
        style={{
          width: open ? `${panelWidth}px` : '0px',
          minWidth: open ? `${minWidth}px` : '0px',
          maxWidth: open ? `${maxWidth}px` : '0px',
        }}
      >
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-black/10 bg-card px-3 select-none">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-xs font-semibold text-ink truncate">{title}</h2>
            {shortcutHint && (
              <kbd className="inline-flex items-center rounded border border-black/15 bg-black/[0.04] px-1.5 py-0.5 text-[10px] font-mono font-medium text-ink/70">
                {shortcutHint}
              </kbd>
            )}
          </div>
          <button
            type="button"
            aria-label={`Collapse ${title} shelf`}
            title={`Collapse ${title}${shortcutHint ? ` (${shortcutHint})` : ''}`}
            data-testid={`collapse-shelf-${side}`}
            onClick={() => onOpenChange(false)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-ink/70 hover:text-ink hover:bg-black/[0.05] transition-colors focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {side === 'left' ? (
              <ChevronLeft className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {children}
        </div>

        {open && (
          // biome-ignore lint/a11y/useSemanticElements: interactive splitter separator represents a resizable pane divider
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-valuenow={panelWidth}
            aria-valuemin={minWidth}
            aria-valuemax={maxWidth}
            aria-label={`Resize ${title} shelf`}
            data-testid={`shelf-resize-handle-${side}`}
            onPointerDown={handlePointerDown}
            onKeyDown={handleKeyDown}
            className={cn(
              'absolute top-0 bottom-0 z-20 flex w-2 cursor-col-resize items-center justify-center transition-colors group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              side === 'left'
                ? '-right-1 hover:bg-primary/20'
                : '-left-1 hover:bg-primary/20',
              isResizing && 'bg-primary/30'
            )}
          >
            <div className="h-8 w-0.5 rounded-full bg-black/20 group-hover:bg-primary transition-colors" />
          </div>
        )}
      </aside>

      {!open && (
        <button
          type="button"
          aria-label={`Open ${title} shelf`}
          title={`Open ${title}${shortcutHint ? ` (${shortcutHint})` : ''}`}
          data-testid={`shelf-edge-trigger-${side}`}
          onClick={() => onOpenChange(true)}
          className={cn(
            'absolute top-12 z-20 flex items-center gap-1.5 h-9 bg-card/95 backdrop-blur-sm text-ink shadow-md hover:bg-card hover:shadow-lg transition-all focus-visible:ring-2 focus-visible:ring-primary/40 cursor-pointer select-none',
            side === 'left'
              ? 'left-0 pl-2.5 pr-3 rounded-r-md border-y border-r border-black/15 hover:border-black/25'
              : 'right-0 pl-3 pr-2.5 rounded-l-md border-y border-l border-black/15 hover:border-black/25'
          )}
        >
          {side === 'left' ? (
            <ChevronRight className="h-4 w-4 text-ink/70" />
          ) : (
            <ChevronLeft className="h-4 w-4 text-ink/70" />
          )}
          <span className="text-xs font-semibold text-ink">{title}</span>
          {shortcutHint && (
            <kbd className="inline-flex items-center rounded border border-black/15 bg-black/[0.04] px-1 py-0.2 text-[10px] font-mono font-medium text-ink/70">
              {shortcutHint}
            </kbd>
          )}
        </button>
      )}
    </>
  )
}
