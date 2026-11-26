import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useEffect, useRef } from 'react'
import type { LibraryRow } from '../../../bindings/loom/internal/service'
import { selectAsset } from '../../lib/selection'
import { Button } from '../ui/button'

interface Props {
  path: string
  rows: LibraryRow[]
  selected: number[]
  search: string
  status: string
  pairing: string
  tagId: number
  mode: string
  loading: boolean
  error: boolean
  onSelect: (ids: number[]) => void
  onContextMenu: (ids: number[], x: number, y: number) => void
  onRetry: () => void
  onPreview?: (id: number) => void
  reveal?: { id: number; folder: string | null } | null
}

export function AssetList({
  path,
  rows,
  selected,
  search,
  status,
  pairing,
  tagId,
  mode,
  loading,
  error,
  onSelect,
  onContextMenu,
  onRetry,
  onPreview,
  reveal = null,
}: Props) {
  const anchor = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const scrolledReveal = useRef<typeof reveal>(null)
  // Locate-in-Assets selects the row, but the list may be scrolled
  // elsewhere or still loading after a mode/folder switch: bring the
  // row into view once it renders. Consumed per reveal request (object
  // identity), so later list refreshes don't yank scroll back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows is a timing dependency — refire after the async listing renders.
  useEffect(() => {
    if (!reveal || scrolledReveal.current === reveal) return
    const target = listRef.current?.querySelector<HTMLElement>(
      `[data-asset-id="${reveal.id}"]`
    )
    if (!target) return
    scrolledReveal.current = reveal
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [reveal, rows])
  return (
    <div
      ref={listRef}
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
              <Button size="sm" variant="secondary" onClick={onRetry}>
                <Trans>Retry</Trans>
              </Button>
            </div>
          ) : mode === 'folders' ? (
            <Trans>No assets in this folder.</Trans>
          ) : status === 'missing' ? (
            <Trans>No missing assets match this query.</Trans>
          ) : status === 'trashed' && !search && !pairing && !tagId ? (
            <Trans>Trash is empty.</Trans>
          ) : pairing === 'unpaired' ? (
            <Trans>No unpaired assets match. Try All relationships.</Trans>
          ) : search || status !== 'active' || pairing || tagId ? (
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
          onDoubleClick={() => onPreview?.(row.id)}
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
            event.dataTransfer.setData(
              'text/plain',
              `${ids.length} Loom asset${ids.length === 1 ? '' : 's'}`
            )
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
            loading="lazy"
            decoding="async"
            draggable={false}
            className="h-9 w-9 rounded object-cover"
          />
          <span className="truncate">{row.fileName}</span>
        </button>
      ))}
    </div>
  )
}
