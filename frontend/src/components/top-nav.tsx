import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'
import { Redo2, Undo2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/utils'

interface TopNavProps {
  repoName: string
  active: 'canvas' | 'library'
  boardHref: string
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  children?: ReactNode
}

export function TopNav({
  repoName,
  active,
  boardHref,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  children,
}: TopNavProps) {
  return (
    <div className="flex h-12 flex-none items-center justify-between border-b border-black/6 px-4">
      <div className="flex items-center gap-4">
        <div className="text-[13px] font-semibold text-ink">{repoName}</div>
        <div className="flex gap-0.5 rounded-sm bg-surface p-0.5">
          <Link
            to={boardHref}
            className={cn(
              'rounded-[3px] px-2.5 py-1 text-[11.5px] font-semibold',
              active === 'canvas'
                ? 'bg-white text-ink shadow-sm'
                : 'text-ink-subtle hover:text-ink'
            )}
          >
            <Trans>Canvas</Trans>
          </Link>
          <Link
            to="/library"
            className={cn(
              'rounded-[3px] px-2.5 py-1 text-[11.5px] font-semibold',
              active === 'library'
                ? 'bg-white text-ink shadow-sm'
                : 'text-ink-subtle hover:text-ink'
            )}
          >
            <Trans>Library</Trans>
          </Link>
        </div>
      </div>
      <div className="flex items-center gap-3.5">
        {children}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            title={t`Undo`}
            disabled={!canUndo}
            onClick={onUndo}
            className="flex h-7 w-7 items-center justify-center rounded text-ink-muted hover:bg-black/[0.04] disabled:opacity-30"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={t`Redo`}
            disabled={!canRedo}
            onClick={onRedo}
            className="flex h-7 w-7 items-center justify-center rounded text-ink-muted hover:bg-black/[0.04] disabled:opacity-30"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
