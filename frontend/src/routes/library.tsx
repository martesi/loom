import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BoardSummary,
  LibraryRow,
  RepoInfo,
  TagInfo,
} from '../../bindings/loom/internal/service'
import {
  BoardService,
  ImageService,
  LibraryService,
  SystemService,
  TagService,
  UndoService,
} from '../../bindings/loom/internal/service'
import { BoardPicker } from '../components/board/board-picker'
import type { MenuAction } from '../components/menu'
import { PositionedMenu } from '../components/menu'
import { TopNav } from '../components/top-nav'
import { useUndoShortcuts } from '../lib/use-undo'
import { cn } from '../lib/utils'

interface LibraryProps {
  repo: RepoInfo
}

export function Library({ repo }: LibraryProps) {
  const [rows, setRows] = useState<LibraryRow[]>([])
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [tags, setTags] = useState<TagInfo[]>([])
  const [search, setSearch] = useState('')
  const [boardFilter, setBoardFilter] = useState(0) // 0 = any, -1 = unassigned
  const [statusFilter, setStatusFilter] = useState('')
  const [tagFilter, setTagFilter] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [undoState, setUndoState] = useState({ canUndo: false, canRedo: false })
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

  const refreshUndoState = useCallback(() => {
    UndoService.State(repo.path).then((s) => s && setUndoState(s))
  }, [repo.path])

  const refresh = useCallback(() => {
    LibraryService.ListImages(repo.path, {
      search,
      boardId: boardFilter,
      status: statusFilter,
      tagId: tagFilter,
    }).then((list) => setRows(list ?? []))
    BoardService.ListBoards(repo.path).then((list) => setBoards(list ?? []))
    TagService.ListTags(repo.path).then((list) => setTags(list ?? []))
    refreshUndoState()
  }, [
    repo.path,
    search,
    boardFilter,
    statusFilter,
    tagFilter,
    refreshUndoState,
  ])

  useEffect(() => {
    const timeout = setTimeout(refresh, 150)
    return () => clearTimeout(timeout)
  }, [refresh])

  useUndoShortcuts(repo.path, refresh)

  // Cross-navigation from the canvas: /library#img-<id> scrolls to and
  // highlights the row — this is the list-side half of the "find in
  // list"/"show on board" cross-navigation pair.
  useEffect(() => {
    const match = window.location.hash.match(/^#img-(\d+)$/)
    if (match) {
      setHighlightId(Number(match[1]))
      window.history.replaceState(null, '', window.location.pathname)
    }
  }, [])
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
      if (!memberBoards || memberBoards.length === 0) {
        return
      }
      // With exactly one board, jump straight there; with several, the
      // first is used as a reasonable default rather than blocking on a
      // picker — see spec: "prompt to pick one if it's on multiple" is the
      // richer version, this is the pragmatic v1.
      navigate({
        to: '/board/$boardId',
        params: { boardId: String(memberBoards[0].id) },
        hash: `img-${row.id}`,
      })
    },
    [repo.path, navigate]
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

  const handleUndo = () =>
    UndoService.Undo(repo.path).then((result) => {
      if (result?.applied) refresh()
      refreshUndoState()
    })
  const handleRedo = () =>
    UndoService.Redo(repo.path).then((result) => {
      if (result?.applied) refresh()
      refreshUndoState()
    })

  return (
    <div className="flex h-screen flex-col bg-surface-canvas">
      <TopNav
        repoName={repo.name}
        active="library"
        boardHref="/board"
        canUndo={undoState.canUndo}
        canRedo={undoState.canRedo}
        onUndo={handleUndo}
        onRedo={handleRedo}
      />

      <div className="flex items-center gap-3 border-b border-black/6 px-6 py-3.5">
        <div className="flex h-[34px] max-w-[320px] flex-1 items-center gap-2 rounded-md border border-black/14 px-2.5">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t`Search prompts, filenames, tags…`}
            className="w-full text-[12.5px] text-ink outline-none placeholder:text-ink-subtle"
          />
        </div>
        <select
          value={tagFilter}
          onChange={(e) => setTagFilter(Number(e.target.value))}
          className="rounded-full border border-black/12 px-3 py-1.5 text-[12px] font-medium text-ink-muted"
        >
          <option value={0}>{t`Tags: any`}</option>
          {tags.map((tg) => (
            <option key={tg.id} value={tg.id}>
              {tg.name}
            </option>
          ))}
        </select>
        <select
          value={boardFilter}
          onChange={(e) => setBoardFilter(Number(e.target.value))}
          className="rounded-full border border-black/12 px-3 py-1.5 text-[12px] font-medium text-ink-muted"
        >
          <option value={0}>{t`Board: any`}</option>
          <option value={-1}>{t`Unassigned`}</option>
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-full border border-black/12 px-3 py-1.5 text-[12px] font-medium text-ink-muted"
        >
          <option value="">{t`Active`}</option>
          <option value="archived">{t`Archived`}</option>
          <option value="trashed">{t`Trashed`}</option>
          <option value="all">{t`All`}</option>
        </select>
      </div>

      <div className="flex-1 overflow-y-auto pb-16">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-black/6 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
              <th className="w-10 px-6 py-2.5" />
              <th className="w-14 px-2 py-2.5" />
              <th className="px-2 py-2.5">
                <Trans>Prompt</Trans>
              </th>
              <th className="px-2 py-2.5">
                <Trans>Tags</Trans>
              </th>
              <th className="px-2 py-2.5">
                <Trans>Board</Trans>
              </th>
              <th className="px-2 py-2.5">
                <Trans>Date</Trans>
              </th>
              <th className="px-2 py-2.5">
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
                  'border-b border-black/4 text-[12.5px]',
                  selected.has(row.id) && 'bg-accent-soft',
                  row.id === highlightId &&
                    'bg-accent-soft ring-2 ring-inset ring-accent'
                )}
              >
                <td className="px-6 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(row.id)}
                    onChange={() => toggleSelected(row.id)}
                  />
                </td>
                <td className="px-2 py-2">
                  <div className="h-[38px] w-[38px] overflow-hidden rounded-md bg-[repeating-linear-gradient(45deg,#EDEBE9_0px,#EDEBE9_8px,#E1DFDD_8px,#E1DFDD_16px)]">
                    {row.thumbUrl && (
                      <img
                        src={row.thumbUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    )}
                  </div>
                </td>
                <td className="px-2 py-2">
                  <div className="font-semibold text-ink">{row.fileName}</div>
                  <div className="truncate text-[11.5px] text-ink-subtle">
                    {row.promptText || '—'}
                  </div>
                </td>
                <td className="px-2 py-2">
                  <div className="flex flex-wrap gap-1">
                    {(row.tags ?? []).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-surface px-2 py-0.5 text-[10.5px] text-ink-muted"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-2 py-2 text-ink-muted">
                  {(row.boards ?? []).join(', ') || '—'}
                </td>
                <td className="px-2 py-2 text-ink-subtle">
                  {new Date(row.createdAt).toLocaleDateString()}
                </td>
                <td className="px-2 py-2">
                  {row.missing && (
                    <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10.5px] font-semibold text-danger">
                      <Trans>Missing</Trans>
                    </span>
                  )}
                  {!row.missing && row.trashed && (
                    <span className="rounded-full bg-surface px-2 py-0.5 text-[10.5px] font-semibold text-ink-subtle">
                      <Trans>Trashed</Trans>
                    </span>
                  )}
                  {!row.missing && !row.trashed && row.archived && (
                    <span className="rounded-full bg-surface px-2 py-0.5 text-[10.5px] font-semibold text-ink-subtle">
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
        <div className="fixed bottom-4 left-1/2 flex h-11 w-[min(640px,90vw)] -translate-x-1/2 items-center justify-between rounded-lg bg-ink px-4 shadow-lg">
          <span className="text-[12.5px] font-semibold text-white">
            {selected.size} <Trans>selected</Trans>
          </span>
          <div className="flex gap-4">
            <button
              type="button"
              onClick={(e) =>
                setBoardPickerFor({
                  x: e.clientX,
                  y: e.clientY - 200,
                  imageIds: selectedIds,
                })
              }
              className="text-[12px] font-semibold text-white hover:underline"
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
              className="text-[12px] font-semibold text-white hover:underline"
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
              className="text-[12px] font-semibold text-[#FF9E9E] hover:underline"
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
