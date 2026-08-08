import { Trans } from '@lingui/react/macro'
import type { DragEvent, MouseEvent, ReactNode } from 'react'
import { cn } from '../../lib/utils'

// The subset of ImageInfo/LibraryRow's shape this row actually renders —
// structural typing lets both LibraryPanel's LibraryRow and Explorer's raw
// ImageInfo satisfy it without either panel reshaping its data.
export interface RowImage {
  id: number
  fileName: string
  thumbUrl: string
  promptText: string
  archived: boolean
  trashed: boolean
  missing: boolean
}

interface PanelImageRowProps {
  image: RowImage
  // Ctrl/cmd+click always fires this instead of onRowClick, regardless of
  // panel — see board.tsx's detailImageId/activeTab wiring.
  onDetailRequest: (imageId: number) => void
  // Plain-click behavior is panel-specific (Library toggles a checkbox
  // selection, Explorer currently has no row-click behavior at all) so it's
  // left as an optional callback rather than baked into this component.
  onRowClick?: (image: RowImage, event: MouseEvent) => void
  thumbSize?: number
  showStatusBadges?: boolean
  className?: string
  // Extra content appended after the standard filename/prompt block (e.g.
  // Library's tags/board/date columns render outside this component, but a
  // panel can still tack something onto the same flex row via children).
  children?: ReactNode
  // Drag source onto the canvas (Stage 12). Explorer opts out (its own
  // treeitem wrapper already owns dragging for folder-move) by passing
  // false. When the dragged row is part of a larger active selection
  // (dragImageIds), the whole selection drags together.
  draggable?: boolean
  dragImageIds?: number[]
}

// Shared identity block (thumbnail + filename + prompt subtitle + optional
// status badges) used by both LibraryPanel's table rows and Explorer's tree
// rows — previously duplicated between the two (see explorer-panel.tsx's
// pre-Stage-9 comment). Also owns the ctrl/cmd+click -> onDetailRequest
// routing so both panels get it identically.
export function PanelImageRow({
  image,
  onDetailRequest,
  onRowClick,
  thumbSize = 32,
  showStatusBadges = true,
  className,
  children,
  draggable = true,
  dragImageIds,
}: PanelImageRowProps) {
  const handleClick = (event: MouseEvent) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      event.stopPropagation()
      onDetailRequest(image.id)
      return
    }
    onRowClick?.(image, event)
  }

  const handleDragStart = (event: DragEvent) => {
    const ids =
      dragImageIds &&
      dragImageIds.includes(image.id) &&
      dragImageIds.length > 1
        ? dragImageIds
        : [image.id]
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(
      'application/x-loom-image-id',
      ids.length > 1 ? JSON.stringify(ids) : String(ids[0])
    )
  }

  // ctrl/cmd+click is a modifier-key power-user shortcut layered on top of
  // each panel's real, already keyboard-accessible row controls (Library's
  // checkbox, Explorer's role="treeitem" wrapper) — not a replacement for
  // them, so there's no separate keyboard equivalent to wire up here.
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: see comment above.
    // biome-ignore lint/a11y/useKeyWithClickEvents: see comment above.
    <div
      className={cn('flex min-w-0 flex-1 items-center gap-2', className)}
      onClick={handleClick}
      draggable={draggable}
      onDragStart={draggable ? handleDragStart : undefined}
    >
      <div
        className="flex-none overflow-hidden rounded-md bg-[repeating-linear-gradient(45deg,#EDEBE9_0px,#EDEBE9_8px,#E1DFDD_8px,#E1DFDD_16px)]"
        style={{ width: thumbSize, height: thumbSize }}
      >
        {image.thumbUrl && (
          <img
            src={image.thumbUrl}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold text-ink">{image.fileName}</div>
        <div className="truncate text-[11px] text-ink-subtle">
          {image.promptText || '—'}
        </div>
      </div>
      {showStatusBadges && (
        <>
          {image.missing && (
            <span className="flex-none rounded-full bg-danger-soft px-2 py-0.5 text-[10px] font-semibold text-danger">
              <Trans>Missing</Trans>
            </span>
          )}
          {!image.missing && image.trashed && (
            <span className="flex-none rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold text-ink-subtle">
              <Trans>Trashed</Trans>
            </span>
          )}
          {!image.missing && !image.trashed && image.archived && (
            <span className="flex-none rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold text-ink-subtle">
              <Trans>Archived</Trans>
            </span>
          )}
        </>
      )}
      {children}
    </div>
  )
}
