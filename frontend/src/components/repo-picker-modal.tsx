import { Dialog } from '@base-ui-components/react/dialog'
import { Trans } from '@lingui/react/macro'
import { ChevronUp, Folder, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FSDirListing } from '../../bindings/loom/internal/service'
import { RepoService } from '../../bindings/loom/internal/service'
import { Button } from './ui/button'

interface RepoPickerModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (path: string) => void
}

// Server mode's substitute for the native folder dialog (RepoService's
// OpenFolder/CreateRepo, whose Dialog.OpenFile is unavailable when built
// headless — see internal/webauth's neighbor, main_server.go). Walks
// RepoService.BrowseDirectory starting from the server's home directory;
// "Open this folder" hands the resolved path to RepoService.OpenRecent via
// onSelect exactly like clicking a recent-repo entry does, since that
// already bootstraps .loom/ if the folder is new.
export function RepoPickerModal({
  open,
  onOpenChange,
  onSelect,
}: RepoPickerModalProps) {
  const [path, setPath] = useState<string | undefined>(undefined)
  const [listing, setListing] = useState<FSDirListing | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    RepoService.BrowseDirectory(path ?? '')
      .then((result) => {
        setListing(result ?? null)
        setError(null)
      })
      .catch(() => setError('Could not browse that folder.'))
  }, [open, path])

  useEffect(() => {
    if (!open) {
      setPath(undefined)
      setListing(null)
      setError(null)
    }
  }, [open])

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[1px] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex h-[440px] w-[480px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-black/8 bg-card p-4 shadow-lg outline-none data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-[13px] font-semibold text-ink">
              <Trans>Choose a folder</Trans>
            </Dialog.Title>
            <Dialog.Close className="flex h-6 w-6 items-center justify-center rounded-md text-ink-muted hover:bg-black/[0.04] hover:text-ink">
              <X className="h-3.5 w-3.5" />
            </Dialog.Close>
          </div>

          <div className="mb-2 flex items-center gap-1.5 truncate text-[11.5px] text-ink-subtle">
            {listing?.parent ? (
              <button
                type="button"
                onClick={() => setPath(listing.parent)}
                className="flex h-6 w-6 flex-none items-center justify-center rounded-md hover:bg-black/[0.04]"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
            ) : null}
            <span className="truncate">{listing?.path ?? path ?? ''}</span>
          </div>

          <div className="flex-1 overflow-y-auto rounded-md border border-black/6">
            {error ? (
              <div className="p-3 text-[12px] text-ink-subtle">{error}</div>
            ) : null}
            {listing && (listing.entries ?? []).length === 0 ? (
              <div className="p-3 text-[12px] text-ink-subtle">
                <Trans>No subfolders here.</Trans>
              </div>
            ) : null}
            {(listing?.entries ?? []).map((entry) => (
              <button
                type="button"
                key={entry.path}
                onClick={() => setPath(entry.path)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-ink hover:bg-black/[0.03]"
              >
                <Folder className="h-3.5 w-3.5 flex-none text-ink-subtle" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.isRepo ? (
                  <span className="flex-none text-[10.5px] text-ink-subtle">
                    <Trans>repo</Trans>
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="mt-3 flex justify-end gap-2">
            <Dialog.Close render={<Button variant="secondary" size="sm" />}>
              <Trans>Cancel</Trans>
            </Dialog.Close>
            <Button
              variant="primary"
              size="sm"
              disabled={!listing}
              onClick={() => listing && onSelect(listing.path)}
            >
              {listing?.isRepo ? (
                <Trans>Open this folder</Trans>
              ) : (
                <Trans>Create repo here</Trans>
              )}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
