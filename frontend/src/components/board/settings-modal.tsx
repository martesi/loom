import { Dialog } from '@base-ui-components/react/dialog'
import { Trans } from '@lingui/react/macro'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { BoardService } from '../../../bindings/loom/internal/service'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'

interface SettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoPath: string
  boardId: number
  layoutMode: string
  onLayoutModeChange: () => void
  onRescan: () => void
  showFileName: boolean
  onShowFileNameChange: (value: boolean) => void
}

// Settings modal (Stage 11), opened from the gear icon in FloatingPanel's
// footer row (not CanvasToolbar — see panel-unification-plan.md's Stage 11
// correction). Built on base-ui's Dialog, the first use of that primitive in
// this codebase (Select/Toast wrap other base-ui parts already).
//
// This pass only surfaces the Manual/Auto layout-mode toggle, relocated here
// from the removed TopNav. It's deliberately structured as a list of
// "settings sections" so it's obvious how a future pass adds more
// SettingsService-backed controls (e.g. panel visibility/dock side from
// Stage 7, "defaults now, UI later" per the plan doc) without restructuring
// this component.
export function SettingsModal({
  open,
  onOpenChange,
  repoPath,
  boardId,
  layoutMode,
  onLayoutModeChange,
  onRescan,
  showFileName,
  onShowFileNameChange,
}: SettingsModalProps) {
  const setLayoutMode = (mode: 'manual' | 'auto') => {
    if (mode === layoutMode) return
    BoardService.SetLayoutMode(repoPath, boardId, mode).then(onLayoutModeChange)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[1px] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-black/8 bg-card p-4 shadow-lg outline-none data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-[13px] font-semibold text-ink">
              <Trans>Settings</Trans>
            </Dialog.Title>
            <Dialog.Close className="flex h-6 w-6 items-center justify-center rounded-md text-ink-muted hover:bg-black/[0.04] hover:text-ink">
              <X className="h-3.5 w-3.5" />
            </Dialog.Close>
          </div>

          <section>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
              <Trans>Layout</Trans>
            </h3>
            <div className="flex rounded-sm bg-surface p-0.5">
              <ModeButton
                active={layoutMode === 'manual'}
                onClick={() => setLayoutMode('manual')}
              >
                <Trans>Manual</Trans>
              </ModeButton>
              <ModeButton
                active={layoutMode === 'auto'}
                onClick={() => setLayoutMode('auto')}
              >
                <Trans>Auto</Trans>
              </ModeButton>
            </div>
          </section>

          <section className="mt-3">
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
              <Trans>Display</Trans>
            </h3>
            <label className="flex items-center gap-2 text-[12.5px] text-ink">
              <input
                type="checkbox"
                checked={showFileName}
                onChange={(e) => onShowFileNameChange(e.target.checked)}
              />
              <Trans>Show file names on hover</Trans>
            </label>
          </section>

          <section className="mt-3">
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
              <Trans>Library</Trans>
            </h3>
            <Button variant="secondary" size="sm" onClick={onRescan}>
              <Trans>Rescan folder for new images</Trans>
            </Button>
          </section>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

interface ModeButtonProps {
  active: boolean
  onClick: () => void
  children: ReactNode
}

function ModeButton({ active, onClick, children }: ModeButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 rounded-[3px] px-2.5 py-1.5 text-[12px] font-semibold',
        active
          ? 'bg-white text-ink shadow-sm'
          : 'text-ink-subtle hover:text-ink'
      )}
    >
      {children}
    </button>
  )
}
