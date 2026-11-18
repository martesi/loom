import { t } from '@lingui/core/macro'
import { Focus, Maximize2, MoreHorizontal, RotateCcw } from 'lucide-react'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { displayShortcut, isMacPlatform } from '../../lib/action-catalog'

export interface CanvasDockProps {
  onFitAll: () => void
  onFitSelection: () => void
  onResetZoom: () => void
  onAutoArrange: () => void
  canFitAll: boolean
  canFitSelection: boolean
  canAutoArrange: boolean
  shortcuts: {
    fitAll: string
    fitSelection: string
    resetZoom: string
    autoArrange: string
  }
}

interface DockButtonProps {
  label: string
  shortcut?: string
  icon: React.ReactNode
  disabled?: boolean
  onClick: () => void
  testId?: string
}

function DockButton({
  label,
  shortcut,
  icon,
  disabled = false,
  onClick,
  testId,
}: DockButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold text-ink transition-all hover:bg-black/[0.06] active:scale-95 disabled:pointer-events-none disabled:opacity-40"
    >
      <span className="shrink-0">{icon}</span>
      <span>{label}</span>
      {shortcut && (
        <kbd className="ml-0.5 rounded bg-black/5 px-1 py-0.5 font-mono text-[10px] text-ink-muted">
          {shortcut}
        </kbd>
      )}
    </button>
  )
}

export function CanvasDock({
  onFitAll,
  onFitSelection,
  onResetZoom,
  onAutoArrange,
  canFitAll,
  canFitSelection,
  canAutoArrange,
  shortcuts,
}: CanvasDockProps) {
  const [moreOpen, setMoreOpen] = useState(false)
  const isMac = isMacPlatform()
  const dockRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!moreOpen) return
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      if (
        !(event.target instanceof Node) ||
        dockRef.current?.contains(event.target)
      )
        return
      setMoreOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setMoreOpen(false)
    }
    document.addEventListener('pointerdown', dismissOnOutsidePointer, true)
    document.addEventListener('keydown', dismissOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', dismissOnOutsidePointer, true)
      document.removeEventListener('keydown', dismissOnEscape, true)
    }
  }, [moreOpen])

  return (
    <div
      ref={dockRef}
      data-testid="canvas-dock"
      role="toolbar"
      aria-label={t`Canvas Actions`}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card/90 p-1.5 shadow-2xl backdrop-blur-xl"
    >
      <DockButton
        testId="dock-fit-all"
        label={t`Fit all`}
        shortcut={displayShortcut(shortcuts.fitAll, isMac)}
        icon={<Maximize2 className="h-3.5 w-3.5" />}
        disabled={!canFitAll}
        onClick={onFitAll}
      />
      <DockButton
        testId="dock-fit-selection"
        label={t`Fit selection`}
        shortcut={displayShortcut(shortcuts.fitSelection, isMac)}
        icon={<Focus className="h-3.5 w-3.5" />}
        disabled={!canFitSelection}
        onClick={onFitSelection}
      />
      <DockButton
        testId="dock-reset-zoom"
        label={t`Reset 100%`}
        shortcut={displayShortcut(shortcuts.resetZoom, isMac)}
        icon={<RotateCcw className="h-3.5 w-3.5" />}
        onClick={onResetZoom}
      />
      <div className="relative my-auto ml-0.5 h-8 w-8">
        <button
          type="button"
          aria-label={t`More Canvas actions`}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          data-testid="dock-more"
          onClick={(event) => {
            event.stopPropagation()
            setMoreOpen((open) => !open)
          }}
          onPointerDown={(event) => event.stopPropagation()}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink transition-colors hover:bg-black/[0.06] focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {moreOpen && (
          <div
            role="menu"
            aria-label={t`More Canvas actions`}
            data-testid="dock-more-menu"
            className="absolute bottom-10 right-0 z-30 min-w-44 rounded-lg border border-border bg-card p-1.5 shadow-xl"
          >
            <button
              type="button"
              role="menuitem"
              data-testid="dock-auto-arrange"
              disabled={!canAutoArrange}
              onClick={(event) => {
                event.stopPropagation()
                setMoreOpen(false)
                onAutoArrange()
              }}
              className="flex w-full items-center justify-between gap-4 rounded px-3 py-2 text-left text-xs font-medium text-ink hover:bg-black/[0.05] focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-45"
            >
              <span>{t`Auto-arrange`}</span>
              <kbd className="font-mono text-[10px] text-ink-subtle">
                {displayShortcut(shortcuts.autoArrange, isMac)}
              </kbd>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
