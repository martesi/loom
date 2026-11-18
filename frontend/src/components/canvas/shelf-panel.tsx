import { t } from '@lingui/core/macro'
import { ChevronLeft, ChevronRight, Pin } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'

export interface ShelfPanelProps {
  title: string
  side: 'left' | 'right'
  open: boolean
  onOpenChange: (open: boolean) => void
  pinned: boolean
  onPinnedChange: (pinned: boolean) => void
  focusHidden?: boolean
  deferOpeningFocus?: boolean
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
  pinned,
  onPinnedChange,
  focusHidden = false,
  deferOpeningFocus = false,
  shortcutHint,
  children,
  width = DEFAULT_WIDTH,
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth = DEFAULT_MAX_WIDTH,
}: ShelfPanelProps) {
  const [panelWidth, setPanelWidth] = useState(width)
  const [isResizing, setIsResizing] = useState(false)
  const asideRef = useRef<HTMLElement>(null)
  const openingFocusDeferred = useRef(false)
  const visible = open && !focusHidden

  useEffect(() => {
    if (width !== undefined) {
      setPanelWidth(width)
    }
  }, [width])

  useEffect(() => {
    if (!visible) {
      openingFocusDeferred.current = false
      return
    }
    if (deferOpeningFocus) {
      openingFocusDeferred.current = true
      return
    }
    if (openingFocusDeferred.current) return
    const frame = requestAnimationFrame(() => {
      const target = asideRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex="0"]'
      )
      if (target) target.focus()
      else asideRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible, deferOpeningFocus])

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
        aria-hidden={!visible}
        inert={!visible}
        data-state={open ? 'open' : 'closed'}
        data-visible={visible}
        data-side={side}
        className={cn(
          'absolute inset-y-3 z-30 flex flex-col overflow-visible rounded-xl border border-black/10 bg-card/95 shadow-2xl backdrop-blur-xl select-none',
          !isResizing &&
            'transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none',
          side === 'left' ? 'left-3' : 'right-3',
          !visible && 'pointer-events-none opacity-0',
          side === 'left' && !visible && '-translate-x-[calc(100%+1rem)]',
          side === 'right' && !visible && 'translate-x-[calc(100%+1rem)]',
          'max-[720px]:!w-[calc(100vw-24px)] max-[720px]:!min-w-0 max-[720px]:max-w-[calc(100vw-24px)]'
        )}
        style={{
          width: `${panelWidth}px`,
          minWidth: `${Math.min(minWidth, 240)}px`,
          maxWidth: `${maxWidth}px`,
        }}
      >
        <div className="flex h-10 shrink-0 items-center justify-between rounded-t-xl border-b border-black/10 bg-card/90 px-3 select-none">
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
            aria-label={
              pinned ? t`Unpin ${title} drawer` : t`Pin ${title} drawer`
            }
            aria-pressed={pinned}
            title={
              pinned
                ? t`Keep ${title} open`
                : t`Allow ${title} to close after actions`
            }
            data-testid={`pin-shelf-${side}`}
            onClick={() => onPinnedChange(!pinned)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-ink/70 hover:bg-black/[0.05] hover:text-ink transition-colors focus-visible:ring-2 focus-visible:ring-primary/40 aria-pressed:text-primary"
          >
            <Pin className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={t`Collapse ${title} shelf`}
            title={
              shortcutHint
                ? t`Collapse ${title} (${shortcutHint})`
                : t`Collapse ${title}`
            }
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

        {visible && (
          // biome-ignore lint/a11y/useSemanticElements: interactive splitter separator represents a resizable pane divider
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-valuenow={panelWidth}
            aria-valuemin={minWidth}
            aria-valuemax={maxWidth}
            aria-label={t`Resize ${title} shelf`}
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

      {!visible && !focusHidden && (
        <button
          type="button"
          aria-label={t`Open ${title} shelf`}
          aria-expanded={open}
          title={
            shortcutHint ? t`Open ${title} (${shortcutHint})` : t`Open ${title}`
          }
          data-testid={`shelf-edge-trigger-${side}`}
          onClick={() => onOpenChange(true)}
          className={cn(
            'group absolute top-16 z-20 flex h-9 w-9 items-center gap-1.5 overflow-hidden border border-black/15 bg-card/95 text-ink shadow-md backdrop-blur-sm transition-[width,background,box-shadow] hover:w-auto hover:bg-card hover:shadow-lg focus-visible:z-40 focus-visible:w-auto focus-visible:ring-2 focus-visible:ring-primary/40 cursor-pointer select-none motion-reduce:transition-none',
            side === 'left'
              ? 'left-0 rounded-r-md pl-2.5 pr-2'
              : 'right-0 flex-row-reverse rounded-l-md pl-2 pr-2.5'
          )}
        >
          {side === 'left' ? (
            <ChevronRight className="h-4 w-4 text-ink/70" />
          ) : (
            <ChevronLeft className="h-4 w-4 text-ink/70" />
          )}
          <span className="whitespace-nowrap text-xs font-semibold text-ink opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none">
            {title}
          </span>
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
