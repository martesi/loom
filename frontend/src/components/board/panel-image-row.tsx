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
  // Click handling (including modifier keys) is entirely panel-specific:
  // Library and Explorer both implement plain-click-selects,
  // shift-click-range, and ctrl/cmd-click-toggles selection themselves —
  // ctrl/cmd is reserved for that here, not for jumping to Detail (that's
  // the canvas node click's gesture, via board.tsx's handleNodeClick; lists
  // reach Detail by narrowing selection to one row, or the row context
  // menu's "Show details").
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
// pre-Stage-9 comment). Click handling is left entirely to onRowClick; see
// its doc comment for why ctrl/cmd isn't special-cased here.
export function PanelImageRow({
  image,
  onRowClick,
  thumbSize = 32,
  showStatusBadges = true,
  className,
  children,
  draggable = true,
  dragImageIds,
}: PanelImageRowProps) {
  const handleClick = (event: MouseEvent) => {
    onRowClick?.(image, event)
  }

  const handleDragStart = (event: DragEvent) => {
    const ids =
      dragImageIds && dragImageIds.includes(image.id) && dragImageIds.length > 1
        ? dragImageIds
        : [image.id]
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(
      'application/x-loom-image-id',
      ids.length > 1 ? JSON.stringify(ids) : String(ids[0])
    )
  }

  // Click selection is layered on top of each panel's real, already
  // keyboard-accessible row controls (Library's checkbox, Explorer's
  // role="treeitem" wrapper) — not a replacement for them, so there's no
  // separate keyboard equivalent to wire up here.
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
        {image.promptText && (
          <div className="truncate text-[11px] text-ink-subtle">
            {image.promptText}
          </div>
        )}
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
