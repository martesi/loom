import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { LibraryRow } from '../../../bindings/loom/internal/service'
import { selectAsset } from '../../lib/selection'

interface Props {
  rows: LibraryRow[]
  selected: number[]
  select: (ids: number[]) => void
  onContextMenu: (ids: number[], x: number, y: number) => void
  density: number
  fit: 'cover' | 'contain'
  overlays: {
    filename: boolean
    dimensions: boolean
    tags: boolean
    prompt: boolean
  }
}

export function AssetGallery({
  rows,
  selected,
  select,
  onContextMenu,
  density,
  fit,
  overlays,
}: Props) {
  const anchor = useRef<number | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  const cardWidth = [112, 168, 240][density] ?? 168
  const [columnCount, setColumnCount] = useState(1)
  useEffect(() => {
    const element = grid.current
    if (!element) return
    const resize = () =>
      setColumnCount(
        Math.max(1, Math.floor((element.clientWidth - 8) / (cardWidth + 8)))
      )
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    return () => observer.disconnect()
  }, [cardWidth])
  const cardRows = Array.from(
    { length: Math.ceil(rows.length / columnCount) },
    (_, index) => rows.slice(index * columnCount, (index + 1) * columnCount)
  )
  const focusId = rows.some((row) => row.id === selected[0])
    ? selected[0]
    : rows[0]?.id

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>) {
    if (
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    )
      return
    event.preventDefault()

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const visualRows = [
        ...(grid.current?.querySelectorAll<HTMLElement>('[role="row"]') ?? []),
      ]
      const currentRow =
        event.currentTarget.closest<HTMLElement>('[role="row"]')
      if (!currentRow) return
      const rowIndex = visualRows.indexOf(currentRow)
      const targetRow =
        visualRows[rowIndex + (event.key === 'ArrowDown' ? 1 : -1)]
      if (!targetRow) return

      const current = event.currentTarget.getBoundingClientRect()
      const centerX = current.left + current.width / 2
      const targetCards = [
        ...targetRow.querySelectorAll<HTMLButtonElement>('[data-gallery-card]'),
      ]
      targetCards.sort((left, right) => {
        const leftRect = left.getBoundingClientRect()
        const rightRect = right.getBoundingClientRect()
        const leftCenter = leftRect.left + leftRect.width / 2
        const rightCenter = rightRect.left + rightRect.width / 2
        return Math.abs(leftCenter - centerX) - Math.abs(rightCenter - centerX)
      })
      targetCards[0]?.focus()
      return
    }

    const current = event.currentTarget.getBoundingClientRect()
    const center = {
      x: current.left + current.width / 2,
      y: current.top + current.height / 2,
    }
    const candidates = [
      ...(grid.current?.querySelectorAll<HTMLButtonElement>(
        '[data-gallery-card]'
      ) ?? []),
    ]
      .filter((candidate) => candidate !== event.currentTarget)
      .map((candidate) => {
        const rect = candidate.getBoundingClientRect()
        const point = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        }
        const dx = point.x - center.x
        const dy = point.y - center.y
        const isAhead =
          event.key === 'ArrowRight'
            ? dx > 0
            : event.key === 'ArrowLeft'
              ? dx < 0
              : event.key === 'ArrowDown'
                ? dy > 0
                : dy < 0
        return { candidate, dx, dy, isAhead }
      })
      .filter((candidate) => candidate.isAhead)
      .sort((left, right) => {
        const horizontal =
          event.key === 'ArrowLeft' || event.key === 'ArrowRight'
        const primary = horizontal
          ? Math.abs(left.dx) - Math.abs(right.dx)
          : Math.abs(left.dy) - Math.abs(right.dy)
        const secondary = horizontal
          ? Math.abs(left.dy) - Math.abs(right.dy)
          : Math.abs(left.dx) - Math.abs(right.dx)
        return primary || secondary
      })
    candidates[0]?.candidate.focus()
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: The CSS gallery needs an ARIA grid for two-dimensional keyboard navigation.
    <div
      ref={grid}
      role="grid"
      aria-label={t`Asset gallery`}
      aria-multiselectable="true"
      className="flex min-h-0 flex-1 flex-col content-start gap-2 overflow-auto p-2"
    >
      {cardRows.map((cardRow) => (
        // biome-ignore lint/a11y/useSemanticElements: ARIA grid rows pair their cells while keeping the card layout CSS-driven.
        <div
          role="row"
          tabIndex={-1}
          key={cardRow.map((row) => row.id).join('-')}
          className="grid gap-2"
          style={{
            gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
          }}
        >
          {cardRow.map((row) => {
            const label = [
              row.fileName,
              `${row.width} × ${row.height}`,
              ...(row.tags ?? []),
              row.promptText,
            ]
              .filter(Boolean)
              .join(', ')
            return (
              // biome-ignore lint/a11y/useSemanticElements: Grid cells expose selected state within the keyboard-navigable gallery.
              <div
                role="gridcell"
                aria-selected={selected.includes(row.id)}
                tabIndex={-1}
                key={row.id}
              >
                <button
                  type="button"
                  data-gallery-card
                  aria-label={label}
                  aria-pressed={selected.includes(row.id)}
                  tabIndex={row.id === focusId ? 0 : -1}
                  draggable
                  className="group w-full overflow-hidden rounded-md border border-border bg-card text-left outline-none hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/50 aria-pressed:border-primary aria-pressed:bg-primary/5"
                  onKeyDown={moveFocus}
                  onClick={(event) => {
                    select(
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
                    if (!selected.includes(row.id)) select(ids)
                    anchor.current = row.id
                    onContextMenu(ids, event.clientX, event.clientY)
                  }}
                  onDragStart={(event) => {
                    const ids = selected.includes(row.id) ? selected : [row.id]
                    select(ids)
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
                    className={`aspect-square w-full bg-black/[0.04] ${fit === 'cover' ? 'object-cover' : 'object-contain'}`}
                  />
                  {(overlays.filename ||
                    overlays.dimensions ||
                    overlays.tags ||
                    overlays.prompt) && (
                    <span className="grid gap-0.5 p-1.5 text-[10px] leading-tight text-ink-muted">
                      {overlays.filename && (
                        <span className="truncate font-medium text-ink">
                          {row.fileName}
                        </span>
                      )}
                      {overlays.dimensions && (
                        <span>
                          {row.width} × {row.height}
                        </span>
                      )}
                      {overlays.tags && !!row.tags?.length && (
                        <span className="truncate">{row.tags.join(', ')}</span>
                      )}
                      {overlays.prompt && !!row.promptText && (
                        <span className="line-clamp-2">{row.promptText}</span>
                      )}
                    </span>
                  )}
                </button>
              </div>
            )
          })}
        </div>
      ))}
      {rows.length === 0 && (
        // biome-ignore lint/a11y/useSemanticElements: Empty-state content remains a grid cell so the grid structure is complete.
        <div role="row" tabIndex={-1}>
          {/* biome-ignore lint/a11y/useSemanticElements: Grid cells expose selected state within the keyboard-navigable gallery. */}
          <div role="gridcell" tabIndex={-1}>
            <p className="px-3 py-6 text-center text-[11.5px] leading-relaxed text-ink-muted">
              <Trans>No assets match these filters.</Trans>
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
