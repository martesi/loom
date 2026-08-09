import { t } from '@lingui/core/macro'
import {
  Archive,
  Group,
  Hand,
  LayoutGrid,
  Link2,
  MousePointer2,
  Trash2,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import type { CanvasTool } from '../../routes/board'

interface CanvasToolbarProps {
  tool: CanvasTool
  // Space is held, temporarily forcing pan-on-left-drag regardless of
  // `tool` (see board.tsx's panOnDrag computation) — reflected here as a
  // transient Move-icon highlight so the toolbar doesn't silently disagree
  // with what dragging the canvas actually does right now.
  spaceHeld?: boolean
  onToolChange: (tool: CanvasTool) => void
  onGroupSelection: () => void
  groupDisabled: boolean
  onAutoArrange: () => void
  autoArrangeDisabled: boolean
  onArchiveToggle: () => void
  archiveDisabled: boolean
  archiveActive: boolean
  onTrash: () => void
  trashDisabled: boolean
}

export function CanvasToolbar({
  tool,
  spaceHeld,
  onToolChange,
  onGroupSelection,
  groupDisabled,
  onAutoArrange,
  autoArrangeDisabled,
  onArchiveToggle,
  archiveDisabled,
  archiveActive,
  onTrash,
  trashDisabled,
}: CanvasToolbarProps) {
  // Anchored opposite FloatingPanel's default left dock (floating-panel.tsx)
  // so the two overlays don't occlude each other; there's no dock-side UI
  // yet (Stage 7's "defaults now, UI later"), so this isn't dockSide-aware.
  return (
    <div className="absolute right-4 top-4 z-10 flex w-[52px] flex-col gap-1.5 rounded-lg border border-black/8 bg-white/92 p-2 shadow-md backdrop-blur-sm">
      <ToolbarButton
        active={tool === 'select' && !spaceHeld}
        title={t`Select — left-drag to box-select, middle-mouse or Space to pan`}
        onClick={() => onToolChange('select')}
      >
        <MousePointer2 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        active={tool === 'move' || spaceHeld}
        title={t`Move — left-drag to pan the canvas`}
        onClick={() => onToolChange('move')}
      >
        <Hand className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        disabled
        title={t`Drag from a node's edge to link images — a dedicated link tool arrives in a later stage`}
      >
        <Link2 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        disabled={groupDisabled}
        title={t`Group selected images as a set`}
        onClick={onGroupSelection}
      >
        <Group className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        disabled={autoArrangeDisabled}
        title={t`Auto-arrange selection`}
        onClick={onAutoArrange}
      >
        <LayoutGrid className="h-4 w-4" />
      </ToolbarButton>
      <div className="my-0.5 h-px bg-black/8" />
      <ToolbarButton
        disabled={archiveDisabled}
        title={archiveActive ? t`Unarchive selection` : t`Archive selection`}
        onClick={onArchiveToggle}
      >
        <Archive className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        disabled={trashDisabled}
        danger
        title={t`Trash selection`}
        onClick={onTrash}
      >
        <Trash2 className="h-4 w-4" />
      </ToolbarButton>
    </div>
  )
}

interface ToolbarButtonProps {
  active?: boolean
  disabled?: boolean
  danger?: boolean
  title: string
  onClick?: () => void
  children: ReactNode
}

function ToolbarButton({
  active,
  disabled,
  danger,
  title,
  onClick,
  children,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-md transition-colors',
        danger ? 'text-danger' : 'text-ink-muted',
        active && 'bg-primary text-white',
        disabled && 'cursor-default opacity-40',
        !active &&
          !disabled &&
          (danger
            ? 'hover:bg-danger-soft'
            : 'hover:bg-black/[0.04] hover:text-ink')
      )}
    >
      {children}
    </button>
  )
}
