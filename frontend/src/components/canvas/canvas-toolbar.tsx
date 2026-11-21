import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { Command, MoreHorizontal, PanelLeft, PanelRight } from 'lucide-react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { RepoInfo } from '../../../bindings/loom/internal/service'
import { cn } from '../../lib/utils'
import { Tooltip } from '../ui/tooltip'
import { RepoSelect } from './repo-select'

interface Props {
  repo: RepoInfo
  repoOpenRequest: number
  focusCanvas: boolean
  assetsOpen: boolean
  inspectorOpen: boolean
  repoMenuOpen: boolean
  setRepoMenuOpen: Dispatch<SetStateAction<boolean>>
  repoMenuRef: RefObject<HTMLDivElement | null>
  importInput: RefObject<HTMLInputElement | null>
  actionShortcut: (id: string) => string | undefined
  openPalette: (shortcuts?: boolean, initialQuery?: string) => void
  executeActionById: (id: string) => void
  toggleFocusMode: () => void
  onImportFiles: (files: File[]) => void
}

export function CanvasToolbar({
  repo,
  repoOpenRequest,
  focusCanvas,
  assetsOpen,
  inspectorOpen,
  repoMenuOpen,
  setRepoMenuOpen,
  repoMenuRef,
  importInput,
  actionShortcut,
  openPalette,
  executeActionById,
  toggleFocusMode,
  onImportFiles,
}: Props) {
  return (
    <>
      <div
        role="toolbar"
        aria-label={t`Canvas workspace controls`}
        data-testid="canvas-workspace-controls"
        aria-hidden={focusCanvas}
        inert={focusCanvas}
        className={cn(
          'absolute left-1/2 top-3 z-40 flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card/95 p-1.5 shadow-xl backdrop-blur-xl transition-opacity motion-reduce:transition-none',
          focusCanvas && 'pointer-events-none opacity-0'
        )}
      >
        <h1 className="sr-only">
          <Trans>Canvas</Trans>
        </h1>
        <RepoSelect repo={repo} openRequest={repoOpenRequest} />
        <Tooltip
          label={t`Show commands`}
          shortcut={actionShortcut('show-commands')}
        >
          <button
            type="button"
            aria-label={t`Show commands`}
            data-testid="open-command-palette"
            onClick={() => openPalette(false)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink/75 transition-colors hover:bg-accent hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <Command className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip
          label={t`Toggle Assets`}
          shortcut={actionShortcut('toggle-assets')}
          side="bottom"
        >
          <button
            type="button"
            aria-label={t`Assets`}
            aria-pressed={assetsOpen}
            aria-expanded={assetsOpen}
            data-testid="toggle-assets-shelf"
            onClick={() => executeActionById('toggle-assets')}
            className={cn(
              'inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-primary/40',
              assetsOpen
                ? 'bg-primary-soft text-ink'
                : 'text-ink/75 hover:bg-accent hover:text-ink'
            )}
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip
          label={t`Toggle Inspector`}
          shortcut={actionShortcut('toggle-inspector')}
          side="bottom"
        >
          <button
            type="button"
            aria-label={t`Inspector`}
            aria-pressed={inspectorOpen}
            aria-expanded={inspectorOpen}
            data-testid="toggle-inspector-shelf"
            onClick={() => executeActionById('toggle-inspector')}
            className={cn(
              'inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-primary/40',
              inspectorOpen
                ? 'bg-primary-soft text-ink'
                : 'text-ink/75 hover:bg-accent hover:text-ink'
            )}
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </Tooltip>
        <div className="relative" ref={repoMenuRef}>
          <Tooltip label={t`Repository actions`}>
            <button
              type="button"
              aria-label={t`Repository actions`}
              aria-haspopup="menu"
              aria-expanded={repoMenuOpen}
              data-testid="repository-actions"
              onClick={() => setRepoMenuOpen((open) => !open)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink/75 transition-colors hover:bg-accent hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </Tooltip>
          {repoMenuOpen && (
            <div
              role="menu"
              aria-label={t`Repository actions`}
              className="absolute right-0 top-11 z-50 grid min-w-44 gap-1 rounded-lg border border-border bg-card p-1.5 shadow-xl"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setRepoMenuOpen(false)
                  executeActionById('open-settings')
                }}
                className="rounded px-3 py-2 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <Trans>Settings…</Trans>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setRepoMenuOpen(false)
                  executeActionById('rescan-repository')
                }}
                className="rounded px-3 py-2 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <Trans>Rescan repository</Trans>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setRepoMenuOpen(false)
                  importInput.current?.click()
                }}
                className="rounded px-3 py-2 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <Trans>Import media</Trans>
              </button>
            </div>
          )}
        </div>
        <input
          ref={importInput}
          type="file"
          multiple
          accept="image/*,video/*"
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            onImportFiles(files)
            event.target.value = ''
          }}
        />
      </div>
      {focusCanvas && (
        <Tooltip
          label={t`Exit Focus Canvas`}
          shortcut={actionShortcut('toggle-focus-canvas')}
        >
          <button
            type="button"
            aria-label={t`Exit Focus Canvas mode`}
            onClick={toggleFocusMode}
            className="group absolute left-0 top-1/2 z-40 flex h-12 w-2 -translate-y-1/2 items-center gap-2 overflow-hidden rounded-r-full border border-border bg-card/70 px-1 text-xs font-medium text-ink opacity-55 shadow-lg backdrop-blur transition-[width,opacity] hover:w-48 hover:bg-card/90 hover:opacity-100 focus-visible:w-48 focus-visible:bg-card/90 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
          >
            <PanelLeft className="h-4 w-4 rotate-180" />
            <span className="whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">
              <Trans>Exit Focus Canvas</Trans>
            </span>
          </button>
        </Tooltip>
      )}
    </>
  )
}
