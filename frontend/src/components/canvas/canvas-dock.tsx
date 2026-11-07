import { Boxes, Focus, LayoutGrid, Maximize2, RotateCcw } from 'lucide-react'
import type React from 'react'

export interface CanvasDockProps {
  onFitAll: () => void
  onFitSelection: () => void
  onResetZoom: () => void
  onAutoArrange: () => void
  onCreateSet: () => void
  canFitAll: boolean
  canFitSelection: boolean
  canAutoArrange: boolean
  canCreateSet: boolean
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
  onCreateSet,
  canFitAll,
  canFitSelection,
  canAutoArrange,
  canCreateSet,
}: CanvasDockProps) {
  return (
    <div
      data-testid="canvas-dock"
      role="toolbar"
      aria-label="Canvas Actions"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card/90 p-1.5 shadow-2xl backdrop-blur-xl"
    >
      <DockButton
        testId="dock-fit-all"
        label="Fit all"
        shortcut="⇧1"
        icon={<Maximize2 className="h-3.5 w-3.5" />}
        disabled={!canFitAll}
        onClick={onFitAll}
      />
      <DockButton
        testId="dock-fit-selection"
        label="Fit selection"
        shortcut="⇧2"
        icon={<Focus className="h-3.5 w-3.5" />}
        disabled={!canFitSelection}
        onClick={onFitSelection}
      />
      <DockButton
        testId="dock-reset-zoom"
        label="Reset 100%"
        shortcut="⌘0"
        icon={<RotateCcw className="h-3.5 w-3.5" />}
        onClick={onResetZoom}
      />
      <div className="my-auto h-4 w-px bg-border" />
      <DockButton
        testId="dock-auto-arrange"
        label="Auto-arrange"
        shortcut="⇧A"
        icon={<LayoutGrid className="h-3.5 w-3.5" />}
        disabled={!canAutoArrange}
        onClick={onAutoArrange}
      />
      <DockButton
        testId="dock-create-set"
        label="Create set"
        shortcut="⌘G"
        icon={<Boxes className="h-3.5 w-3.5" />}
        disabled={!canCreateSet}
        onClick={onCreateSet}
      />
    </div>
  )
}
