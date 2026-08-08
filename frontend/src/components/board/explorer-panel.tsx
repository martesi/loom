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
import { PanelImageRow } from './panel-image-row'

interface ExplorerPanelProps {
  repo: RepoInfo
  onDetailRequest: (imageId: number) => void
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
export function ExplorerPanel({ repo, onDetailRequest }: ExplorerPanelProps) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set())
  const [dirCache, setDirCache] = useState<Map<string, DirListing>>(
    () => new Map()
  )
  const pendingRef = useRef<Set<string>>(new Set())
  const dragRef = useRef<DragPayload | null>(null)
  const parentRef = useRef<HTMLDivElement>(null)

  const [dragOverDir, setDragOverDir] = useState<string | null>(null)
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

  const rowMenuItems: MenuAction[] = useMemo(() => {
    if (!rowMenu) return []
    const { row } = rowMenu
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
    ]
  }, [rowMenu])

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
                  />
                ) : (
                  <FileRow
                    row={row}
                    onDetailRequest={onDetailRequest}
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
                      setRowMenu({ x: e.clientX, y: e.clientY, row })
                    }}
                    onDragStart={(e) => {
                      dragRef.current = {
                        image: row.image,
                        dirPath: row.dirPath,
                      }
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
}

function DirRow({
  row,
  expanded,
  dragOver,
  onToggle,
  onDragOver,
  onDragLeave,
  onDrop,
}: DirRowProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'flex h-[34px] w-full items-center gap-1.5 border-b border-black/4 px-1.5 text-left text-[11.5px] font-semibold text-ink hover:bg-black/[0.03]',
        dragOver && 'bg-accent-soft ring-2 ring-inset ring-accent'
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
  onDetailRequest: (imageId: number) => void
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
  onDetailRequest,
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
      aria-selected={renaming}
      tabIndex={0}
      draggable={!renaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className="flex h-[40px] w-full items-center gap-1.5 border-b border-black/4 px-1.5 text-[11.5px]"
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
              className="w-full rounded-sm border border-accent px-1 text-[11.5px] text-ink outline-none"
            />
            <div className="truncate text-[10.5px] text-ink-subtle">
              {image.promptText || '—'}
            </div>
          </div>
        </div>
      ) : (
        <PanelImageRow
          image={image}
          onDetailRequest={onDetailRequest}
          thumbSize={28}
          draggable={false}
        />
      )}
    </div>
  )
}
