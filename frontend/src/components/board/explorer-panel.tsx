import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, Folder, FolderOpen } from 'lucide-react'
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DirListing,
  ImageInfo,
  RepoInfo,
} from '../../../bindings/loom/internal/service'
import {
  ImageService,
  SystemService,
} from '../../../bindings/loom/internal/service'
import { cn } from '../../lib/utils'
import type { MenuAction } from '../menu'
import { PositionedMenu } from '../menu'
import { PanelImageRow, type RowImage } from './panel-image-row'

interface ExplorerPanelProps {
  repo: RepoInfo
  // Explicit "go look at this" — the row menu's "Show details" — which
  // also switches the panel to the Detail tab.
  onDetailRequest: (imageId: number) => void
  // Passive counterpart: fired whenever the selection narrows to exactly
  // one file, so Detail's content follows selection the way it already
  // does for a single canvas selection, without forcing a tab switch.
  onPreviewRequest: (imageId: number) => void
  // Bumped by board.tsx after any archive/trash/restore mutation, from the
  // canvas, Library, or Detail — Explorer's dirCache is otherwise only
  // invalidated by moves/trashes/renames it triggers itself (see loadDir),
  // so a trash from elsewhere would otherwise leave a stale row showing
  // the pre-trash state. Same guarded-on-nonzero shape as library-panel.tsx's
  // refreshToken.
  refreshToken: number
}

// The repo root is represented by the empty relative path everywhere in
// this file (ImageService.ListDirectory's own convention) and is always
// walked, unlike every other folder — there's no visible row for it, so it
// isn't a member of expandedDirs, it's just the implicit base of the tree.
const ROOT = ''

function joinRel(dir: string, name: string): string {
  return dir === ROOT ? name : `${dir}/${name}`
}

type DirRowData = {
  kind: 'dir'
  relPath: string
  name: string
  depth: number
}

type FileRowData = {
  kind: 'file'
  dirPath: string
  image: ImageInfo
  depth: number
}

type Row = DirRowData | FileRowData

interface DragPayload {
  image: ImageInfo
  dirPath: string
}

// Lazy-loaded, virtualized file tree (Stage 8). Two independent bounds
// compose here: expandedDirs + dirCache bound what gets *fetched* (only
// expanded folders are ever asked for via ListDirectory), while
// useVirtualizer bounds what gets *mounted* (only rows in the scrollable
// viewport become DOM nodes) — collapsing a folder removes its entire
// subtree from the flattened `rows` array below, not just CSS-hides it, so
// the two bounds don't fight each other.
//
// File rows share their thumbnail/filename/prompt/status-badge markup with
// LibraryPanel via panel-image-row.tsx (Stage 9) — this file only owns the
// tree-specific chrome (indentation, chevrons, drag-and-drop, inline
// rename) around that shared block.
export function ExplorerPanel({
  repo,
  onDetailRequest,
  onPreviewRequest,
  refreshToken,
}: ExplorerPanelProps) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set())
  const [dirCache, setDirCache] = useState<Map<string, DirListing>>(
    () => new Map()
  )
  const dirCacheRef = useRef(dirCache)
  dirCacheRef.current = dirCache
  const pendingRef = useRef<Set<string>>(new Set())
  const dragRef = useRef<DragPayload | null>(null)
  const parentRef = useRef<HTMLDivElement>(null)

  const [dragOverDir, setDragOverDir] = useState<string | null>(null)
  // dragRef alone (a ref) can drive handleDropOnDir's logic fine, but it
  // can't drive a visual style — refs don't trigger re-renders — so the
  // currently-dragged row's id is mirrored into state just for the
  // dragging-opacity treatment below.
  const [draggingImageId, setDraggingImageId] = useState<number | null>(null)
  const [renaming, setRenaming] = useState<{
    dirPath: string
    imageId: number
    value: string
  } | null>(null)
  const [rowMenu, setRowMenu] = useState<{
    x: number
    y: number
    row: FileRowData
  } | null>(null)
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  // Tracks the last file row selected via a plain click, so repeated
  // shift+clicks keep extending from the same starting point — same
  // anchor idiom library-panel.tsx uses for its checkbox rows.
  const selectionAnchorRef = useRef<number | null>(null)

  // Forces a fresh ListDirectory fetch for relPath, overwriting whatever's
  // cached. Used both for first-expand loads and for post-move/rename
  // invalidation of affected directories — pendingRef only dedupes
  // concurrent in-flight requests for the same path, it does not skip a
  // fetch just because the path is already cached.
  const loadDir = useCallback(
    (relPath: string) => {
      if (pendingRef.current.has(relPath)) return
      pendingRef.current.add(relPath)
      ImageService.ListDirectory(repo.path, relPath)
        .then((listing) => {
          if (!listing) return
          setDirCache((prev) => {
            const next = new Map(prev)
            next.set(relPath, listing)
            return next
          })
        })
        .catch((err) => {
          console.error('Failed to list directory', relPath, err)
        })
        .finally(() => {
          pendingRef.current.delete(relPath)
        })
    },
    [repo.path]
  )

  // Root is implicitly expanded — load it once up front.
  useEffect(() => {
    loadDir(ROOT)
  }, [loadDir])

  // Refetches every already-expanded directory when a mutation happens
  // elsewhere (canvas/Library/Detail archive/trash/restore) — see
  // ExplorerPanelProps.refreshToken. The ref keeps this effect from
  // capturing the initial empty cache without making cache updates
  // themselves trigger repeated refetches.
  useEffect(() => {
    if (refreshToken === 0) return
    for (const relPath of dirCacheRef.current.keys()) loadDir(relPath)
  }, [refreshToken, loadDir])

  const toggleDir = useCallback(
    (relPath: string) => {
      setExpandedDirs((prev) => {
        const next = new Set(prev)
        if (next.has(relPath)) {
          next.delete(relPath)
        } else {
          next.add(relPath)
          if (!dirCache.has(relPath)) loadDir(relPath)
        }
        return next
      })
    },
    [dirCache, loadDir]
  )

  // Walks expandedDirs + the fetched-directory cache into one ordered
  // array. A collapsed folder's walk() call is simply never made, so its
  // subtree never enters the array at all — that's what lets the
  // virtualizer below stay correct regardless of how many folders happen
  // to be expanded.
  const rows = useMemo(() => {
    const out: Row[] = []
    const walk = (relPath: string, depth: number) => {
      const listing = dirCache.get(relPath)
      if (!listing) return
      for (const name of listing.dirs ?? []) {
        const childRel = joinRel(relPath, name)
        out.push({ kind: 'dir', relPath: childRel, name, depth })
        if (expandedDirs.has(childRel)) walk(childRel, depth + 1)
      }
      for (const image of listing.files ?? []) {
        out.push({ kind: 'file', dirPath: relPath, image, depth })
      }
    }
    walk(ROOT, 0)
    return out
  }, [dirCache, expandedDirs])

  const toggleFileSelected = useCallback((id: number) => {
    selectionAnchorRef.current = id
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // File-row selection (Explorer/Finder-style, same shape as
  // library-panel.tsx's handleRowClick): plain click selects just this
  // file and sets the shift anchor; shift+click extends the anchor to
  // this file as a range over the flattened `rows` array, skipping over
  // any folder rows in between since only files are selectable; ctrl/cmd
  // toggles just this file in/out of the selection. Ctrl/cmd is
  // deliberately not reserved for anything else here — that's the canvas
  // node click's gesture, not a list row's.
  const handleFileRowClick = useCallback(
    (image: { id: number }, event: MouseEvent) => {
      const id = image.id
      if (event.shiftKey && selectionAnchorRef.current != null) {
        const anchorIdx = rows.findIndex(
          (r) => r.kind === 'file' && r.image.id === selectionAnchorRef.current
        )
        const clickedIdx = rows.findIndex(
          (r) => r.kind === 'file' && r.image.id === id
        )
        if (anchorIdx !== -1 && clickedIdx !== -1) {
          const [start, end] =
            anchorIdx < clickedIdx
              ? [anchorIdx, clickedIdx]
              : [clickedIdx, anchorIdx]
          const rangeIds = rows
            .slice(start, end + 1)
            .filter((r): r is FileRowData => r.kind === 'file')
            .map((r) => r.image.id)
          setSelected((prev) => new Set([...prev, ...rangeIds]))
        }
        return
      }
      if (event.ctrlKey || event.metaKey) {
        toggleFileSelected(id)
        return
      }
      selectionAnchorRef.current = id
      setSelected(new Set([id]))
    },
    [rows, toggleFileSelected]
  )

  // Detail follows a single selected file, same as a single canvas
  // selection — see onPreviewRequest's doc comment on ExplorerPanelProps.
  useEffect(() => {
    if (selected.size === 1) onPreviewRequest([...selected][0])
  }, [selected, onPreviewRequest])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 10,
    getItemKey: (index) => {
      const row = rows[index]
      return row.kind === 'dir' ? `d:${row.relPath}` : `f:${row.image.id}`
    },
  })

  // Shared by drag-drop move and inline rename: both are just MoveFile with
  // a differently-constructed newRelPath. Refetches whichever directories
  // are affected so the tree reflects the move immediately.
  const moveImage = useCallback(
    async (
      image: ImageInfo,
      sourceDir: string,
      targetDir: string,
      newName?: string
    ) => {
      const finalName = newName ?? image.fileName
      if (targetDir === sourceDir && finalName === image.fileName) return
      const newRelPath = joinRel(targetDir, finalName)
      try {
        await ImageService.MoveFile(repo.path, image.id, newRelPath)
      } catch (err) {
        console.error('Failed to move/rename file', err)
        return
      }
      loadDir(sourceDir)
      if (targetDir !== sourceDir) loadDir(targetDir)
    },
    [repo.path, loadDir]
  )

  const handleDropOnDir = useCallback(
    (e: DragEvent, targetDir: string) => {
      e.preventDefault()
      e.stopPropagation()
      setDragOverDir(null)
      const dragging = dragRef.current
      dragRef.current = null
      if (!dragging) return
      moveImage(dragging.image, dragging.dirPath, targetDir)
    },
    [moveImage]
  )

  const confirmRename = useCallback(
    (row: FileRowData, value: string) => {
      setRenaming(null)
      const trimmed = value.trim()
      if (!trimmed) return
      moveImage(row.image, row.dirPath, row.dirPath, trimmed)
    },
    [moveImage]
  )

  const handleTrash = useCallback(
    (row: FileRowData) => {
      ImageService.TrashImage(repo.path, row.image.id).then(() =>
        loadDir(row.dirPath)
      )
    },
    [repo.path, loadDir]
  )

  // Right-click on a row that's part of a multi-selection trashes the
  // whole selection instead of just that row — same "act on the whole
  // selection" convention library-panel.tsx and board.tsx's node menu use.
  const handleTrashSelection = useCallback(
    (rowsToTrash: FileRowData[]) => {
      const dirsToRefresh = new Set(rowsToTrash.map((r) => r.dirPath))
      Promise.all(
        rowsToTrash.map((r) => ImageService.TrashImage(repo.path, r.image.id))
      ).then(() => {
        setSelected(new Set())
        for (const dir of dirsToRefresh) loadDir(dir)
      })
    },
    [repo.path, loadDir]
  )

  const rowMenuItems: MenuAction[] = useMemo(() => {
    if (!rowMenu) return []
    const { row } = rowMenu
    if (selected.has(row.image.id) && selected.size >= 2) {
      const selectedRows = rows.filter(
        (r): r is FileRowData => r.kind === 'file' && selected.has(r.image.id)
      )
      return [
        {
          key: 'trash-selection',
          label: t`Trash ${selectedRows.length} files`,
          danger: true,
          onSelect: () => handleTrashSelection(selectedRows),
        },
      ]
    }
    return [
      {
        key: 'rename',
        label: t`Rename`,
        onSelect: () =>
          setRenaming({
            dirPath: row.dirPath,
            imageId: row.image.id,
            value: row.image.fileName,
          }),
      },
      {
        key: 'reveal',
        label: t`Show in file explorer`,
        onSelect: () => SystemService.RevealInFileExplorer(row.image.filePath),
      },
      {
        key: 'show-details',
        label: t`Show details`,
        onSelect: () => onDetailRequest(row.image.id),
      },
      {
        key: 'trash',
        label: t`Trash`,
        danger: true,
        separatorBefore: true,
        onSelect: () => handleTrash(row),
      },
    ]
  }, [
    rowMenu,
    handleTrash,
    handleTrashSelection,
    selected,
    rows,
    onDetailRequest,
  ])

  const [folderMenu, setFolderMenu] = useState<{
    x: number
    y: number
    parentRelPath: string
  } | null>(null)

  const createFolder = useCallback(
    (parentRelPath: string, name: string) => {
      ImageService.CreateDirectory(repo.path, parentRelPath, name)
        .then(() => {
          loadDir(parentRelPath)
          if (parentRelPath !== ROOT) {
            setExpandedDirs((prev) => new Set(prev).add(parentRelPath))
          }
        })
        .catch((err) => {
          console.error('Failed to create folder', err)
        })
    },
    [repo.path, loadDir]
  )

  return (
    <div className="flex h-full flex-col">
      <div
        ref={parentRef}
        role="tree"
        aria-label={t`File explorer`}
        className="flex-1 overflow-auto"
        onDragOver={(e) => {
          // Blank space beneath the last row acts as a drop target for the
          // repo root, so a file dragged out of a subfolder can be moved
          // back to the top level.
          if (dragRef.current) e.preventDefault()
        }}
        onDrop={(e) => handleDropOnDir(e, ROOT)}
        onContextMenu={(e) => {
          // Right-click on the tree's empty space (below the last row, or
          // the "No files yet" placeholder) — a folder or file row's own
          // onContextMenu (below) stops propagation before this fires, so
          // this only reaches here for genuinely blank space, same
          // targeting rule the drop handler above already uses.
          e.preventDefault()
          setFolderMenu({ x: e.clientX, y: e.clientY, parentRelPath: ROOT })
        }}
      >
        {rows.length === 0 && (
          <div className="p-4 text-[12.5px] text-ink-subtle">
            <Trans>No files yet.</Trans>
          </div>
        )}
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: 'relative',
            width: '100%',
          }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index]
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                {row.kind === 'dir' ? (
                  <DirRow
                    row={row}
                    expanded={expandedDirs.has(row.relPath)}
                    dragOver={dragOverDir === row.relPath}
                    onToggle={() => toggleDir(row.relPath)}
                    onDragOver={(e) => {
                      if (!dragRef.current) return
                      e.preventDefault()
                      setDragOverDir(row.relPath)
                    }}
                    onDragLeave={() =>
                      setDragOverDir((prev) =>
                        prev === row.relPath ? null : prev
                      )
                    }
                    onDrop={(e) => handleDropOnDir(e, row.relPath)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setFolderMenu({
                        x: e.clientX,
                        y: e.clientY,
                        parentRelPath: row.relPath,
                      })
                    }}
                  />
                ) : (
                  <FileRow
                    row={row}
                    onRowClick={handleFileRowClick}
                    selected={selected.has(row.image.id)}
                    dragging={draggingImageId === row.image.id}
                    renaming={renaming?.imageId === row.image.id}
                    renameValue={renaming?.value ?? row.image.fileName}
                    onRenameChange={(value) =>
                      setRenaming((prev) => (prev ? { ...prev, value } : prev))
                    }
                    onRenameCommit={() =>
                      confirmRename(row, renaming?.value ?? '')
                    }
                    onRenameCancel={() => setRenaming(null)}
                    onDoubleClick={() =>
                      setRenaming({
                        dirPath: row.dirPath,
                        imageId: row.image.id,
                        value: row.image.fileName,
                      })
                    }
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      // Right-click on a row outside the current selection
                      // replaces it with just that row, rather than acting
                      // on a stale prior selection — matches Library's and
                      // the canvas's right-click convention.
                      if (!selected.has(row.image.id)) {
                        selectionAnchorRef.current = row.image.id
                        setSelected(new Set([row.image.id]))
                      }
                      setRowMenu({ x: e.clientX, y: e.clientY, row })
                    }}
                    onDragStart={(e) => {
                      dragRef.current = {
                        image: row.image,
                        dirPath: row.dirPath,
                      }
                      setDraggingImageId(row.image.id)
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', String(row.image.id))
                      e.dataTransfer.setData(
                        'application/x-loom-image-id',
                        String(row.image.id)
                      )
                    }}
                    onDragEnd={() => {
                      dragRef.current = null
                      setDragOverDir(null)
                      setDraggingImageId(null)
                    }}
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>

      {rowMenu && (
        <PositionedMenu
          x={rowMenu.x}
          y={rowMenu.y}
          items={rowMenuItems}
          onClose={() => setRowMenu(null)}
        />
      )}
      {folderMenu && (
        <NewFolderPopover
          x={folderMenu.x}
          y={folderMenu.y}
          onSubmit={(name) => createFolder(folderMenu.parentRelPath, name)}
          onClose={() => setFolderMenu(null)}
        />
      )}
    </div>
  )
}

interface DirRowProps {
  row: DirRowData
  expanded: boolean
  dragOver: boolean
  onToggle: () => void
  onDragOver: (e: DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: DragEvent) => void
  onContextMenu: (e: MouseEvent) => void
}

function DirRow({
  row,
  expanded,
  dragOver,
  onToggle,
  onDragOver,
  onDragLeave,
  onDrop,
  onContextMenu,
}: DirRowProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onContextMenu={onContextMenu}
      className={cn(
        'flex h-[34px] w-full items-center gap-1.5 border-b border-black/4 px-1.5 text-left text-[11.5px] font-semibold text-ink hover:bg-black/[0.03]',
        dragOver && 'bg-primary-soft ring-2 ring-inset ring-primary'
      )}
      style={{ paddingLeft: 8 + row.depth * 16 }}
    >
      <ChevronRight
        size={13}
        className={cn(
          'flex-none text-ink-subtle transition-transform',
          expanded && 'rotate-90'
        )}
      />
      {expanded ? (
        <FolderOpen size={14} className="flex-none text-ink-subtle" />
      ) : (
        <Folder size={14} className="flex-none text-ink-subtle" />
      )}
      <span className="truncate">{row.name}</span>
    </button>
  )
}

interface FileRowProps {
  row: FileRowData
  onRowClick: (image: RowImage, event: MouseEvent) => void
  selected: boolean
  dragging: boolean
  renaming: boolean
  renameValue: string
  onRenameChange: (value: string) => void
  onRenameCommit: () => void
  onRenameCancel: () => void
  onDoubleClick: () => void
  onContextMenu: (e: MouseEvent) => void
  onDragStart: (e: DragEvent) => void
  onDragEnd: () => void
}

function FileRow({
  row,
  onRowClick,
  selected,
  dragging,
  renaming,
  renameValue,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onDoubleClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
}: FileRowProps) {
  const { image } = row
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) renameInputRef.current?.focus()
  }, [renaming])

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onRenameCommit()
    else if (e.key === 'Escape') onRenameCancel()
  }

  return (
    <div
      role="treeitem"
      aria-selected={selected || renaming}
      tabIndex={0}
      draggable={!renaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className={cn(
        'flex h-[40px] w-full items-center gap-1.5 border-b border-black/4 px-1.5 text-[11.5px]',
        selected && 'bg-primary-soft',
        dragging && 'opacity-40'
      )}
      style={{ paddingLeft: 8 + row.depth * 16 + 16.5 }}
    >
      {renaming ? (
        // Rename is a transient, tree-specific editing mode — kept as its
        // own small block (thumbnail + text input) rather than teaching the
        // shared PanelImageRow about an input-vs-label swap it has no other
        // use for.
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="h-[28px] w-[28px] flex-none overflow-hidden rounded-md bg-[repeating-linear-gradient(45deg,#EDEBE9_0px,#EDEBE9_8px,#E1DFDD_8px,#E1DFDD_16px)]">
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
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => onRenameChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={onRenameCommit}
              onClick={(e) => e.stopPropagation()}
              className="w-full rounded-sm border border-primary px-1 text-[11.5px] text-ink outline-none"
            />
            {image.promptText && (
              <div className="truncate text-[10.5px] text-ink-subtle">
                {image.promptText}
              </div>
            )}
          </div>
        </div>
      ) : (
        <PanelImageRow
          image={image}
          onRowClick={onRowClick}
          thumbSize={28}
          draggable={false}
        />
      )}
    </div>
  )
}

interface NewFolderPopoverProps {
  x: number
  y: number
  onSubmit: (name: string) => void
  onClose: () => void
}

// "New folder" prompt (Explorer's empty-space and folder-row context
// menus) — a small positioned text input, same shape/dismiss behavior as
// tag-picker.tsx.
function NewFolderPopover({ x, y, onSubmit, onClose }: NewFolderPopoverProps) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onClick = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [onClose])

  const submit = () => {
    const trimmed = value.trim()
    if (trimmed) onSubmit(trimmed)
    onClose()
  }

  return (
    <div
      ref={ref}
      className="fixed z-50 flex w-56 flex-col gap-2 rounded-lg border border-black/8 bg-white p-3 shadow-lg"
      style={{ left: x, top: y }}
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          else if (e.key === 'Escape') onClose()
          e.stopPropagation()
        }}
        placeholder={t`Folder name…`}
        className="w-full rounded-md border border-black/12 px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary"
      />
    </div>
  )
}
