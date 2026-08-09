import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useNavigate } from '@tanstack/react-router'
import type { MouseEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BoardSummary,
  LibraryRow,
  RepoInfo,
  TagInfo,
} from '../../../bindings/loom/internal/service'
import {
  BoardService,
  ImageService,
  LibraryService,
  SystemService,
  TagService,
} from '../../../bindings/loom/internal/service'
import { useCapabilities } from '../../lib/capabilities-store'
import { cn } from '../../lib/utils'
import type { MenuAction } from '../menu'
import { PositionedMenu } from '../menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { BoardPicker } from './board-picker'
import { PanelImageRow } from './panel-image-row'

export interface LibraryRevealRequest {
  imageId: number
  // Bumped on every "find in list" request so the same image can be
  // re-highlighted even if it's already the current highlightId.
  token: number
}

interface LibraryPanelProps {
  repo: RepoInfo
  currentBoardId: number
  onRevealOnCanvas: (imageId: number) => void
  revealRequest: LibraryRevealRequest | null
  refreshToken: number
  // Explicit "go look at this" — the row menu's "Show details" — which
  // also switches the panel to the Detail tab.
  onDetailRequest: (imageId: number) => void
  // Passive counterpart: fired whenever the checked selection narrows to
  // exactly one row, so Detail's content follows selection the way it
  // already does for a single canvas selection, without forcing a tab
  // switch.
  onPreviewRequest: (imageId: number) => void
  // Reports the checkbox multi-selection up to Board (Stage 12), so
  // toolbar actions can target it via lastSelectionSource.
  onSelectionChange?: (ids: number[]) => void
  // Refreshes the parent's board data — called after any archive/trash/
  // restore mutation here, since those can affect a currently-open board's
  // canvas nodes and board.tsx has no other way to learn about a
  // Library-driven mutation (mirrors DetailPanel's onChange).
  onChange?: () => void
}

// Ported from the old /library route (Stage 4) into a FloatingPanel tab
// (Stage 7): same table/filter/bulk-bar, now using the Stage 6 Select. The
// old route's cross-navigation ("Show on board" -> navigate + scroll) is
// replaced with onRevealOnCanvas(imageId) whenever the image is already a
// member of the board that's currently open — a real cross-board
// navigation only happens when the image genuinely lives elsewhere.
export function LibraryPanel({
  repo,
  currentBoardId,
  onRevealOnCanvas,
  revealRequest,
  refreshToken,
  onDetailRequest,
  onPreviewRequest,
  onSelectionChange,
  onChange,
}: LibraryPanelProps) {
  const capabilities = useCapabilities()
  const [rows, setRows] = useState<LibraryRow[]>([])
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [tags, setTags] = useState<TagInfo[]>([])
  const [search, setSearch] = useState('')
  const [boardFilter, setBoardFilter] = useState(0) // 0 = any, -1 = unassigned
  const [statusFilter, setStatusFilter] = useState('')
  const [tagFilter, setTagFilter] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [rowMenu, setRowMenu] = useState<{
    x: number
    y: number
    row: LibraryRow
  } | null>(null)
  // Right-click on a row that's already part of the checked selection acts
  // on the whole selection instead of just that row -- see selectionMenuItems.
  const [selectionMenu, setSelectionMenu] = useState<{
    x: number
    y: number
  } | null>(null)
  const [boardPickerFor, setBoardPickerFor] = useState<{
    x: number
    y: number
    imageIds: number[]
  } | null>(null)
  const [highlightId, setHighlightId] = useState<number | null>(null)
  const highlightRef = useRef<HTMLTableRowElement>(null)
  const navigate = useNavigate()

  const refresh = useCallback(() => {
    LibraryService.ListImages(repo.path, {
      search,
      boardId: boardFilter,
      status: statusFilter,
      tagId: tagFilter,
    }).then((list) => setRows(list ?? []))
    BoardService.ListBoards(repo.path).then((list) => setBoards(list ?? []))
    TagService.ListTags(repo.path).then((list) => setTags(list ?? []))
  }, [repo.path, search, boardFilter, statusFilter, tagFilter])

  useEffect(() => {
    const timeout = setTimeout(refresh, 150)
    return () => clearTimeout(timeout)
  }, [refresh])

  // Undo/redo keyboard shortcuts are wired once, at the board level
  // (board.tsx's useUndoShortcuts) — the panel and canvas are mounted
  // together now rather than being separate routes, so a second shortcut
  // hook here would double-apply every Ctrl/Cmd+Z. board.tsx bumps
  // refreshToken after a successful undo/redo instead, so the table stays
  // in sync without a second global keydown listener. Deliberately keyed
  // only off refreshToken — refresh itself changes on every filter
  // keystroke and would defeat the "only refetch on undo/redo" intent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh intentionally omitted, see above
  useEffect(() => {
    if (refreshToken === 0) return
    refresh()
  }, [refreshToken])

  // Driven by the canvas's node-context-menu "Find in list" action, now
  // that this is a panel tab rather than a /library#img-<id> route. Keyed
  // off revealRequest.token (not the whole object or imageId alone) so the
  // same image can be re-highlighted on a repeat "Find in list" click.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on token only, see above
  useEffect(() => {
    if (!revealRequest) return
    setHighlightId(revealRequest.imageId)
  }, [revealRequest?.token])

  useEffect(() => {
    if (highlightId != null && highlightRef.current) {
      highlightRef.current.scrollIntoView({ block: 'center' })
      const timeout = setTimeout(() => setHighlightId(null), 2500)
      return () => clearTimeout(timeout)
    }
  }, [highlightId])

  // anchorRef tracks the last row selected via plain click or checkbox, so
  // repeated shift+clicks keep extending from the same starting point
  // rather than from wherever the previous shift+click landed.
  const anchorRef = useRef<number | null>(null)

  const toggleSelected = useCallback((id: number) => {
    anchorRef.current = id
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Row click selection (Explorer/Finder-style): plain click selects just
  // this row and sets the shift anchor; shift+click extends the anchor to
  // this row as a contiguous range, merged into whatever's already checked;
  // ctrl/cmd+click toggles just this row in/out of the selection, same as
  // the checkbox. Ctrl/cmd is deliberately not reserved for anything else
  // here — that's the canvas node click's gesture (see board.tsx's
  // handleNodeClick), not a list row's.
  const handleRowClick = useCallback(
    (image: { id: number }, event: MouseEvent) => {
      const id = image.id
      if (event.shiftKey && anchorRef.current != null) {
        const anchorIdx = rows.findIndex((r) => r.id === anchorRef.current)
        const clickedIdx = rows.findIndex((r) => r.id === id)
        if (anchorIdx !== -1 && clickedIdx !== -1) {
          const [start, end] =
            anchorIdx < clickedIdx
              ? [anchorIdx, clickedIdx]
              : [clickedIdx, anchorIdx]
          const rangeIds = rows.slice(start, end + 1).map((r) => r.id)
          setSelected((prev) => new Set([...prev, ...rangeIds]))
        }
        return
      }
      if (event.ctrlKey || event.metaKey) {
        toggleSelected(id)
        return
      }
      anchorRef.current = id
      setSelected(new Set([id]))
    },
    [rows, toggleSelected]
  )

  const handleShowOnBoard = useCallback(
    async (row: LibraryRow) => {
      const memberBoards = await BoardService.BoardsForImage(repo.path, row.id)
      if (!memberBoards || memberBoards.length === 0) return
      if (memberBoards.some((b) => b.id === currentBoardId)) {
        onRevealOnCanvas(row.id)
        return
      }
      // Genuinely elsewhere: the image isn't on the board that's already
      // open, so a real cross-board navigation is the only way to show it.
      navigate({
        to: '/board/$boardId',
        params: { boardId: String(memberBoards[0].id) },
        hash: `img-${row.id}`,
      })
    },
    [repo.path, currentBoardId, onRevealOnCanvas, navigate]
  )

  // Dropping a row's id from `selected` after a mutation keeps the bulk
  // action bar (which is visible purely off `selected.size > 0`) from
  // lingering with a stale count/state once the row it referred to no
  // longer matches — e.g. a restored row falling out of a "Trashed" status
  // filter.
  const dropFromSelection = useCallback((id: number) => {
    setSelected((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const handleArchive = useCallback(
    async (row: LibraryRow) => {
      await ImageService.SetArchived(repo.path, row.id, !row.archived)
      dropFromSelection(row.id)
      refresh()
      onChange?.()
    },
    [repo.path, refresh, onChange, dropFromSelection]
  )
  const handleTrash = useCallback(
    async (row: LibraryRow) => {
      await ImageService.TrashImage(repo.path, row.id)
      dropFromSelection(row.id)
      refresh()
      onChange?.()
    },
    [repo.path, refresh, onChange, dropFromSelection]
  )
  const handleRestore = useCallback(
    async (row: LibraryRow) => {
      await ImageService.RestoreImage(repo.path, row.id)
      dropFromSelection(row.id)
      refresh()
      onChange?.()
    },
    [repo.path, refresh, onChange, dropFromSelection]
  )

  const rowMenuItems: MenuAction[] = useMemo(() => {
    if (!rowMenu) return []
    const { row } = rowMenu
    const items: MenuAction[] = [
      {
        key: 'show-on-board',
        label: t`Show on board`,
        onSelect: () => handleShowOnBoard(row),
      },
      // Meaningless (and pointed at the wrong machine) in server mode: it
      // shells out on whatever host runs the Go process, not the browser's.
      ...(capabilities.isServerMode
        ? []
        : [
            {
              key: 'reveal',
              label: t`Show in file explorer`,
              onSelect: () => SystemService.RevealInFileExplorer(row.filePath),
            },
          ]),
      {
        key: 'show-details',
        label: t`Show details`,
        onSelect: () => onDetailRequest(row.id),
      },
    ]
    if (row.trashed) {
      items.push({
        key: 'restore',
        label: t`Restore from trash`,
        separatorBefore: true,
        onSelect: () => handleRestore(row),
      })
    } else {
      items.push(
        {
          key: 'add-board',
          label: t`Add to board…`,
          separatorBefore: true,
          onSelect: () =>
            setBoardPickerFor({
              x: rowMenu.x,
              y: rowMenu.y,
              imageIds: [row.id],
            }),
        },
        {
          key: 'archive',
          label: row.archived ? t`Unarchive` : t`Archive`,
          onSelect: () => handleArchive(row),
        },
        {
          key: 'trash',
          label: t`Trash`,
          danger: true,
          onSelect: () => handleTrash(row),
        }
      )
    }
    return items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rowMenu,
    handleRestore,
    handleShowOnBoard,
    handleTrash,
    handleArchive,
    onDetailRequest,
    capabilities.isServerMode,
  ])

  const selectedIds = useMemo(() => [...selected], [selected])

  useEffect(() => {
    onSelectionChange?.(selectedIds)
  }, [selectedIds, onSelectionChange])

  // Detail follows a single selected row, same as a single canvas
  // selection — see onPreviewRequest's doc comment on LibraryPanelProps.
  useEffect(() => {
    if (selectedIds.length === 1) onPreviewRequest(selectedIds[0])
  }, [selectedIds, onPreviewRequest])

  // Shared by the bulk-action bar and the multi-row context menu, so both
  // surfaces drive the same batch mutation logic.
  const handleBulkAddToBoard = useCallback(
    (x: number, y: number) => {
      setBoardPickerFor({ x, y, imageIds: selectedIds })
    },
    [selectedIds]
  )
  const handleBulkArchive = useCallback(() => {
    Promise.all(
      selectedIds.map((id) => ImageService.SetArchived(repo.path, id, true))
    ).then(() => {
      setSelected(new Set())
      refresh()
      onChange?.()
    })
  }, [selectedIds, repo.path, refresh, onChange])
  const handleBulkTrash = useCallback(() => {
    Promise.all(
      selectedIds.map((id) => ImageService.TrashImage(repo.path, id))
    ).then(() => {
      setSelected(new Set())
      refresh()
      onChange?.()
    })
  }, [selectedIds, repo.path, refresh, onChange])
  const handleBulkRestore = useCallback(() => {
    Promise.all(
      selectedIds.map((id) => ImageService.RestoreImage(repo.path, id))
    ).then(() => {
      setSelected(new Set())
      refresh()
      onChange?.()
    })
  }, [selectedIds, repo.path, refresh, onChange])

  // Whether the bulk bar/menu's Trash action should really read "Restore" —
  // matches the per-row menu's row.trashed branch (rowMenuItems above), just
  // applied to the whole checked selection instead of one row.
  const allSelectedTrashed = useMemo(
    () =>
      selectedIds.length > 0 &&
      selectedIds.every(
        (id) => rows.find((r) => r.id === id)?.trashed ?? false
      ),
    [selectedIds, rows]
  )

  const selectionMenuItems: MenuAction[] = useMemo(() => {
    if (!selectionMenu || selected.size < 2) return []
    if (allSelectedTrashed) {
      return [
        {
          key: 'restore',
          label: t`Restore from trash`,
          onSelect: handleBulkRestore,
        },
      ]
    }
    return [
      {
        key: 'add-board',
        label: t`Add to board…`,
        onSelect: () => handleBulkAddToBoard(selectionMenu.x, selectionMenu.y),
      },
      {
        key: 'archive',
        label: t`Archive`,
        separatorBefore: true,
        onSelect: handleBulkArchive,
      },
      {
        key: 'trash',
        label: t`Trash`,
        danger: true,
        onSelect: handleBulkTrash,
      },
    ]
  }, [
    selectionMenu,
    selected,
    allSelectedTrashed,
    handleBulkAddToBoard,
    handleBulkArchive,
    handleBulkTrash,
    handleBulkRestore,
  ])

  const tagItems = useMemo(
    () => [
      { label: t`Tags: any`, value: 0 },
      ...tags.map((tg) => ({ label: tg.name, value: tg.id })),
    ],
    [tags]
  )
  const boardItems = useMemo(
    () => [
      { label: t`Board: any`, value: 0 },
      { label: t`Unassigned`, value: -1 },
      ...boards.map((b) => ({ label: b.name, value: b.id })),
    ],
    [boards]
  )
  const statusItems = useMemo(
    () => [
      { label: t`Active`, value: '' },
      { label: t`Archived`, value: 'archived' },
      { label: t`Trashed`, value: 'trashed' },
      { label: t`All`, value: 'all' },
    ],
    []
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-none flex-col gap-2 border-b border-black/6 p-2.5">
        <div className="flex h-[30px] items-center gap-2 rounded-md border border-black/14 px-2.5">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t`Search prompts, filenames, tags…`}
            className="w-full text-[12px] text-ink outline-none placeholder:text-ink-subtle"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Select
            items={tagItems}
            value={tagFilter}
            onValueChange={(v) => setTagFilter(v as number)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tagItems.map((item) => (
                <SelectItem key={String(item.value)} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            items={boardItems}
            value={boardFilter}
            onValueChange={(v) => setBoardFilter(v as number)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {boardItems.map((item) => (
                <SelectItem key={String(item.value)} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            items={statusItems}
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as string)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {statusItems.map((item) => (
                <SelectItem key={String(item.value)} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full min-w-[460px] border-collapse">
          <thead>
            <tr className="border-b border-black/6 text-left text-[10.5px] font-semibold uppercase tracking-wide text-ink-subtle">
              <th className="w-8 px-2.5 py-2" />
              <th className="px-1.5 py-2">
                <Trans>File</Trans>
              </th>
              <th className="px-1.5 py-2">
                <Trans>Tags</Trans>
              </th>
              <th className="px-1.5 py-2">
                <Trans>Board</Trans>
              </th>
              <th className="px-1.5 py-2">
                <Trans>Date</Trans>
              </th>
              <th className="px-1.5 py-2">
                <Trans>Status</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                ref={row.id === highlightId ? highlightRef : undefined}
                onContextMenu={(e) => {
                  e.preventDefault()
                  const alreadySelected = selected.has(row.id)
                  if (!alreadySelected) {
                    // Right-click on a row outside the current checked
                    // selection replaces it with just that row, rather than
                    // acting on a stale prior selection (matches
                    // Explorer/Finder-style right-click).
                    setSelected(new Set([row.id]))
                  }
                  if (alreadySelected && selected.size >= 2) {
                    // Right-clicking a row that's already part of a
                    // multi-selection acts on the whole selection instead of
                    // collapsing to just this one row.
                    setRowMenu(null)
                    setSelectionMenu({ x: e.clientX, y: e.clientY })
                    return
                  }
                  setSelectionMenu(null)
                  setRowMenu({ x: e.clientX, y: e.clientY, row })
                }}
                className={cn(
                  'border-b border-black/4 text-[11.5px]',
                  selected.has(row.id) && 'bg-primary-soft',
                  row.id === highlightId &&
                    'bg-primary-soft ring-2 ring-inset ring-primary'
                )}
              >
                <td className="px-2.5 py-1.5">
                  <input
                    type="checkbox"
                    checked={selected.has(row.id)}
                    onChange={() => toggleSelected(row.id)}
                  />
                </td>
                <td className="px-1.5 py-1.5">
                  <PanelImageRow
                    image={row}
                    onRowClick={handleRowClick}
                    showStatusBadges={false}
                    dragImageIds={selectedIds}
                  />
                </td>
                <td className="px-1.5 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {(row.tags ?? []).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-surface px-2 py-0.5 text-[10px] text-ink-muted"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-1.5 py-1.5 text-ink-muted">
                  {(row.boards ?? []).join(', ') || '—'}
                </td>
                <td className="px-1.5 py-1.5 text-ink-subtle">
                  {new Date(row.createdAt).toLocaleDateString()}
                </td>
                <td className="px-1.5 py-1.5">
                  {row.missing && (
                    <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10px] font-semibold text-danger">
                      <Trans>Missing</Trans>
                    </span>
                  )}
                  {!row.missing && row.trashed && (
                    <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold text-ink-subtle">
                      <Trans>Trashed</Trans>
                    </span>
                  )}
                  {!row.missing && !row.trashed && row.archived && (
                    <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold text-ink-subtle">
                      <Trans>Archived</Trans>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-6 py-10 text-center text-ink-subtle"
                >
                  <Trans>No images match.</Trans>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected.size > 0 && (
        <div className="flex h-10 flex-none items-center justify-between gap-3 border-t border-black/8 bg-white/92 px-3 backdrop-blur-sm">
          <span className="text-[11.5px] font-semibold text-ink">
            {selected.size} <Trans>selected</Trans>
          </span>
          <div className="flex gap-3">
            {allSelectedTrashed ? (
              <button
                type="button"
                onClick={handleBulkRestore}
                className="text-[11.5px] font-semibold text-primary hover:underline"
              >
                <Trans>Restore from trash</Trans>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={(e) =>
                    handleBulkAddToBoard(e.clientX, e.clientY - 200)
                  }
                  className="text-[11.5px] font-semibold text-ink-muted hover:text-ink hover:underline"
                >
                  <Trans>Add to board</Trans>
                </button>
                <button
                  type="button"
                  onClick={handleBulkArchive}
                  className="text-[11.5px] font-semibold text-ink-muted hover:text-ink hover:underline"
                >
                  <Trans>Archive</Trans>
                </button>
                <button
                  type="button"
                  onClick={handleBulkTrash}
                  className="text-[11.5px] font-semibold text-danger hover:underline"
                >
                  <Trans>Trash</Trans>
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {rowMenu && (
        <PositionedMenu
          x={rowMenu.x}
          y={rowMenu.y}
          items={rowMenuItems}
          onClose={() => setRowMenu(null)}
        />
      )}
      {selectionMenu && selectionMenuItems.length > 0 && (
        <PositionedMenu
          x={selectionMenu.x}
          y={selectionMenu.y}
          items={selectionMenuItems}
          onClose={() => setSelectionMenu(null)}
        />
      )}
      {boardPickerFor && (
        <BoardPicker
          x={boardPickerFor.x}
          y={boardPickerFor.y}
          repoPath={repo.path}
          imageIds={boardPickerFor.imageIds}
          boards={boards}
          onClose={() => setBoardPickerFor(null)}
          onChange={refresh}
        />
      )}
    </div>
  )
}
