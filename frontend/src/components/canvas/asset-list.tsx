import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useRef } from 'react'
import type { LibraryRow } from '../../../bindings/loom/internal/service'
import { selectAsset } from '../../lib/selection'
import { Button } from '../ui/button'

interface Props {
  path: string
  rows: LibraryRow[]
  selected: number[]
  search: string
  status: string
  placement: string
  tagId: number
  mode: string
  loading: boolean
  error: boolean
  onSelect: (ids: number[]) => void
  onContextMenu: (ids: number[], x: number, y: number) => void
  onRetry: () => void
}

export function AssetList({
  path,
  rows,
  selected,
  search,
  status,
  placement,
  tagId,
  mode,
  loading,
  error,
  onSelect,
  onContextMenu,
  onRetry,
}: Props) {
  const anchor = useRef<number | null>(null)
  return (
    <div
      role="listbox"
      aria-label={t`Assets`}
      aria-multiselectable="true"
      className="min-h-0 flex-1 overflow-auto"
    >
      {rows.length === 0 && (
        <div className="px-3 py-6 text-center text-[11.5px] leading-relaxed text-ink-muted">
          {loading ? (
            <Trans>Loading assets…</Trans>
          ) : error ? (
            <div className="grid justify-items-center gap-2">
              <Trans>Could not load assets.</Trans>
              <Button size="sm" variant="secondary" onClick={onRetry}><Trans>Retry</Trans></Button>
            </div>
          ) : mode === 'folders' ? (
            <Trans>No assets in this folder.</Trans>
          ) : status === 'missing' ? (
            <Trans>No missing assets match this query.</Trans>
          ) : status === 'trashed' && !search && !placement && !tagId ? (
            <Trans>Trash is empty.</Trans>
          ) : placement === 'unplaced' ? (
            <Trans>No unplaced assets match. Try All placements.</Trans>
          ) : search || status !== 'active' || placement || tagId ? (
            <Trans>No assets match these filters.</Trans>
          ) : (
            <Trans>No assets yet. Import files or rescan the repository.</Trans>
          )}
        </div>
      )}
      {rows.map((row) => (
        <button
          type="button"
          role="option"
          aria-selected={selected.includes(row.id)}
          data-asset-id={row.id}
          key={row.id}
          draggable={!row.missing && !row.trashed}
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left outline-none hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 aria-selected:bg-primary/15"
          onClick={(event) => {
            onSelect(
              selectAsset(
                selected,
                row.id,
                rows.map((item) => item.id),
                anchor.current,
                event.shiftKey,
                event.ctrlKey || event.metaKey
              )
            )
            if (!event.shiftKey) anchor.current = row.id
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            const ids = selected.includes(row.id) ? selected : [row.id]
            if (!selected.includes(row.id)) {
              onSelect(ids)
              anchor.current = row.id
            }
            onContextMenu(ids, event.clientX, event.clientY)
          }}
          onDragStart={(event) => {
            if (row.missing || row.trashed) {
              event.preventDefault()
              return
            }
            const ids = selected.includes(row.id) ? selected : [row.id]
            onSelect(ids)
            event.dataTransfer.setData(
              'application/x-loom-assets',
              JSON.stringify({ repoPath: path, ids })
            )
            // Keep the payload useful to native drop targets without changing
            // Loom's authoritative, repository-scoped asset payload.
            event.dataTransfer.setData('text/plain', `${ids.length} Loom asset${ids.length === 1 ? '' : 's'}`)
            event.dataTransfer.effectAllowed = 'copyMove'
            const preview = document.createElement('div')
            preview.textContent = `${ids.length} asset${ids.length === 1 ? '' : 's'}`
            preview.style.cssText =
              'position:fixed;top:-1000px;left:-1000px;padding:6px 10px;border-radius:6px;background:#222;color:white;font:12px sans-serif'
            document.body.append(preview)
            event.dataTransfer.setDragImage(preview, 8, 8)
            requestAnimationFrame(() => preview.remove())
          }}
        >
          <img
            src={row.thumbUrl}
            alt=""
            draggable={false}
            className="h-9 w-9 rounded object-cover"
          />
          <span className="truncate">{row.fileName}</span>
        </button>
      ))}
    </div>
  )
}
