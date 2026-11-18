import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useRef } from 'react'
import type { LibraryRow } from '../../../bindings/loom/internal/service'
import { selectAsset } from '../../lib/selection'

interface Props {
  rows: LibraryRow[]
  selected: number[]
  search: string
  status: string
  placement: string
  tagId: number
  mode: string
  onSelect: (ids: number[]) => void
  onContextMenu: (ids: number[], x: number, y: number) => void
}

export function AssetList({
  rows,
  selected,
  search,
  status,
  placement,
  tagId,
  mode,
  onSelect,
  onContextMenu,
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
          {mode === 'folders' ? (
            <Trans>No assets in this folder.</Trans>
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
          draggable
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
            const ids = selected.includes(row.id) ? selected : [row.id]
            onSelect(ids)
            event.dataTransfer.setData(
              'application/x-loom-assets',
              JSON.stringify(ids)
            )
            event.dataTransfer.effectAllowed = 'copyMove'
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
