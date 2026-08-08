import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useNavigate } from '@tanstack/react-router'
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
  onDetailRequest: (imageId: number) => void
  // Reports the checkbox multi-selection up to Board (Stage 12), so
  // toolbar actions can target it via lastSelectionSource.
  onSelectionChange?: (ids: number[]) => void
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
  onSelectionChange,
}: LibraryPanelProps) {
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

  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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

  const handleArchive = useCallback(
    async (row: LibraryRow) => {
      await ImageService.SetArchived(repo.path, row.id, !row.archived)
      refresh()
    },
    [repo.path, refresh]
  )
  const handleTrash = useCallback(
    async (row: LibraryRow) => {
      await ImageService.TrashImage(repo.path, row.id)
      refresh()
    },
    [repo.path, refresh]
  )
  const handleRestore = useCallback(
    async (row: LibraryRow) => {
      await ImageService.RestoreImage(repo.path, row.id)
      refresh()
    },
    [repo.path, refresh]
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
      {
        key: 'reveal',
        label: t`Show in file explorer`,
        onSelect: () => SystemService.RevealInFileExplorer(row.filePath),
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
  }, [rowMenu, handleRestore, handleShowOnBoard, handleTrash, handleArchive])

  const selectedIds = useMemo(() => [...selected], [selected])

  useEffect(() => {
    onSelectionChange?.(selectedIds)
  }, [selectedIds, onSelectionChange])

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
                  setRowMenu({ x: e.clientX, y: e.clientY, row })
                }}
                className={cn(
                  'border-b border-black/4 text-[11.5px]',
                  selected.has(row.id) && 'bg-accent-soft',
                  row.id === highlightId &&
                    'bg-accent-soft ring-2 ring-inset ring-accent'
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
                    onDetailRequest={onDetailRequest}
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
        <div className="flex h-10 flex-none items-center justify-between gap-3 border-t border-black/6 bg-ink px-3">
          <span className="text-[11.5px] font-semibold text-white">
            {selected.size} <Trans>selected</Trans>
          </span>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={(e) =>
                setBoardPickerFor({
                  x: e.clientX,
                  y: e.clientY - 200,
                  imageIds: selectedIds,
                })
              }
              className="text-[11.5px] font-semibold text-white hover:underline"
            >
              <Trans>Add to board</Trans>
            </button>
            <button
              type="button"
              onClick={() =>
                Promise.all(
                  selectedIds.map((id) =>
                    ImageService.SetArchived(repo.path, id, true)
                  )
                ).then(() => {
                  setSelected(new Set())
                  refresh()
                })
              }
              className="text-[11.5px] font-semibold text-white hover:underline"
            >
              <Trans>Archive</Trans>
            </button>
            <button
              type="button"
              onClick={() =>
                Promise.all(
                  selectedIds.map((id) =>
                    ImageService.TrashImage(repo.path, id)
                  )
                ).then(() => {
                  setSelected(new Set())
                  refresh()
                })
              }
              className="text-[11.5px] font-semibold text-[#FF9E9E] hover:underline"
            >
              <Trans>Trash</Trans>
            </button>
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
