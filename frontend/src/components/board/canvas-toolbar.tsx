import { t } from '@lingui/core/macro'
import { Group, Link2, MousePointer2, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface CanvasToolbarProps {
  onRescan: () => void
}

export function CanvasToolbar({ onRescan }: CanvasToolbarProps) {
  return (
    <div className="absolute left-4 top-4 z-10 flex w-[52px] flex-col gap-1.5 rounded-lg border border-black/8 bg-white/92 p-2 shadow-md backdrop-blur-sm">
      <ToolbarButton active title={t`Select (default)`}>
        <MousePointer2 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        disabled
        title={t`Drag from a node's edge to link images — a dedicated link tool arrives in a later stage`}
      >
        <Link2 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton disabled title={t`Grouping arrives in a later stage`}>
        <Group className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton title={t`Rescan folder for new images`} onClick={onRescan}>
        <Plus className="h-4 w-4" />
      </ToolbarButton>
    </div>
  )
}

interface ToolbarButtonProps {
  active?: boolean
  disabled?: boolean
  title: string
  onClick?: () => void
  children: ReactNode
}

function ToolbarButton({
  active,
  disabled,
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
        'flex h-9 w-9 items-center justify-center rounded-md text-ink-muted transition-colors',
        active && 'bg-accent text-white',
        disabled && 'cursor-default opacity-40',
        !active && !disabled && 'hover:bg-black/[0.04] hover:text-ink'
      )}
    >
      {children}
    </button>
  )
}
