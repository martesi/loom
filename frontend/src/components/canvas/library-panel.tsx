import { type DragEvent, useEffect, useRef, useState } from 'react'
import {
  ImageService,
  type LibraryRow,
  LibraryService,
  TagService,
} from '../../../bindings/loom/internal/service'
import { type Selection, selectAsset } from '../../lib/selection'

const fieldClass =
  'h-8 w-full rounded-sm border border-black/12 bg-card px-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

interface Props {
  path: string
  selection: Selection
  select: (ids: number[]) => void
  refresh: number
  onError: (e: unknown) => void
  visible: (ids: number[]) => void
  reveal: { id: number; folder: string | null } | null
  change: () => Promise<void>
  compress: (ids: number[]) => void
}
export function LibraryPanel({
  path,
  selection,
  select,
  refresh,
  onError,
  visible,
  reveal,
  change,
  compress,
}: Props) {
  const [mode, setMode] = useState('all'),
    [folder, setFolder] = useState(''),
    [search, setSearch] = useState(''),
    [status, setStatus] = useState('active'),
    [placement, setPlacement] = useState(''),
    [tagId, setTagId] = useState(0),
    [filtersOpen, setFiltersOpen] = useState(false)
  const [rows, setRows] = useState<LibraryRow[]>([]),
    [dirs, setDirs] = useState<string[]>([]),
    [tags, setTags] = useState<{ id: number; name: string }[]>([])
  const [itemMenu, setItemMenu] = useState<{
    x: number
    y: number
    assetIds: number[]
  } | null>(null)
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(
    null
  )
  const anchor = useRef<number | null>(null)
  const callbacks = useRef({ onError, visible })
  callbacks.current = { onError, visible }
  // biome-ignore lint/correctness/useExhaustiveDependencies: repository mutations invalidate the tag catalog.
  useEffect(() => {
    void TagService.ListTags(path)
      .then((t) => setTags(t ?? []))
      .catch(callbacks.current.onError)
  }, [path, refresh])
  useEffect(() => {
    if (!reveal) return
    setMode(reveal.folder === null ? 'all' : 'folders')
    if (reveal.folder !== null) setFolder(reveal.folder)
    setSearch('')
    setStatus('all')
    setPlacement('')
    setTagId(0)
  }, [reveal])
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly invalidates repository listings.
  useEffect(() => {
    let cancelled = false
    async function load() {
      const all = await LibraryService.ListImages(path, {
        search: mode === 'folders' ? '' : search,
        placement: mode === 'folders' ? '' : placement,
        status:
          mode === 'folders' ? 'all' : status === 'missing' ? 'all' : status,
        tagId: mode === 'folders' ? 0 : tagId,
      })
      let list = (all ?? []).filter(
        (r) => mode === 'folders' || status !== 'missing' || r.missing
      )
      if (mode === 'folders') {
        const d = await ImageService.ListDirectory(path, folder)
        if (!cancelled) setDirs(d?.dirs ?? [])
        const ids = new Set(d?.files?.map((f) => f.id))
        list = list.filter((r) => ids.has(r.id))
      }
      if (!cancelled) {
        setRows(list)
        callbacks.current.visible(list.map((r) => r.id))
      }
    }
    void load().catch(callbacks.current.onError)
    return () => {
      cancelled = true
    }
  }, [path, mode, folder, search, status, placement, tagId, refresh])
  useEffect(() => {
    if (!itemMenu) return
    const close = () => setItemMenu(null)
    const clickOutside = (event: MouseEvent) => {
      if (
        event
          .composedPath()
          .some(
            (node) =>
              node instanceof Element && node.getAttribute('role') === 'menu'
          )
      )
        return
      close()
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('click', clickOutside)
    window.addEventListener('keydown', keydown)
    return () => {
      window.removeEventListener('click', clickOutside)
      window.removeEventListener('keydown', keydown)
    }
  }, [itemMenu])
  const selected = selection.surface === 'assets' ? selection.ids : []
  const activeFilterCount =
    Number(status !== 'active') + Number(Boolean(placement)) + Number(tagId > 0)
  const tagName = tags.find((tag) => tag.id === tagId)?.name
  async function moveAssets(ids: number[], targetFolder: string) {
    await Promise.all(
      ids.map((id) => {
        const row = rows.find((item) => item.id === id)
        return row
          ? ImageService.MoveFile(
              path,
              id,
              [targetFolder, row.fileName].filter(Boolean).join('/')
            )
          : Promise.resolve()
      })
    )
    await change()
  }
  function dropInto(event: DragEvent, targetFolder: string) {
    const raw = event.dataTransfer.getData('application/x-loom-assets')
    if (!raw) return
    event.preventDefault()
    try {
      const ids: unknown = JSON.parse(raw)
      if (!Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id)))
        throw new Error('Invalid asset drag')
      void moveAssets(ids, targetFolder).catch(onError)
    } catch (error) {
      onError(error)
    }
  }
  function renameAsset(id: number, name: string) {
    const row = rows.find((item) => item.id === id)
    if (!row) return
    if (!name || name === row.fileName) return
    if (/[\\/]/.test(name)) {
      onError(new Error('File name cannot contain / or \\'))
      return
    }
    void ImageService.MoveFile(
      path,
      id,
      [folder, name].filter(Boolean).join('/')
    )
      .then(() => change())
      .catch(onError)
  }
  return (
    <div
      className="flex min-h-0 flex-1 flex-col text-xs"
      onPointerDownCapture={() => {
        if (selection.surface !== 'assets') select([])
      }}
    >
      <div className="flex p-2">
        {['all', 'folders'].map((m) => (
          <button
            type="button"
            key={m}
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            className="h-8 flex-1 rounded-sm px-2 font-semibold text-ink-muted outline-none transition-colors hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-primary/40 aria-pressed:bg-primary-soft aria-pressed:text-ink"
          >
            {m === 'all' ? 'All Assets' : 'Folders'}
          </button>
        ))}
      </div>
      {mode === 'all' ? (
        <div className="grid gap-2 p-2">
          <div className="flex gap-1.5">
            <input
              className={fieldClass}
              aria-label="Search assets"
              placeholder="Search assets"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              type="button"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((open) => !open)}
              className="h-8 shrink-0 rounded-sm border border-black/12 px-2.5 font-semibold text-ink-muted outline-none hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Filters{activeFilterCount ? ` ${activeFilterCount}` : ''}
            </button>
          </div>
          {filtersOpen && (
            <div className="grid gap-1.5 rounded-md border border-black/6 bg-black/[0.015] p-2">
              <select
                className={fieldClass}
                aria-label="Asset state"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {['active', 'all', 'archived', 'trashed', 'missing'].map(
                  (s) => (
                    <option key={s}>{s}</option>
                  )
                )}
              </select>
              <select
                className={fieldClass}
                aria-label="Placement"
                value={placement}
                onChange={(e) => setPlacement(e.target.value)}
              >
                <option value="">All placements</option>
                <option>placed</option>
                <option>unplaced</option>
              </select>
              <select
                className={fieldClass}
                aria-label="Tag filter"
                value={tagId}
                onChange={(e) => setTagId(Number(e.target.value))}
              >
                <option value={0}>All tags</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {activeFilterCount > 0 && (
            <div className="flex flex-wrap gap-1">
              {status !== 'active' && (
                <button
                  type="button"
                  onClick={() => setStatus('active')}
                  className="rounded-full bg-primary-soft px-2 py-1 text-[11px] text-ink"
                >
                  {status} ×
                </button>
              )}
              {placement && (
                <button
                  type="button"
                  onClick={() => setPlacement('')}
                  className="rounded-full bg-primary-soft px-2 py-1 text-[11px] text-ink"
                >
                  {placement} ×
                </button>
              )}
              {tagId > 0 && (
                <button
                  type="button"
                  onClick={() => setTagId(0)}
                  className="rounded-full bg-primary-soft px-2 py-1 text-[11px] text-ink"
                >
                  {tagName ?? 'tag'} ×
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="p-2">
          <div className="mb-1 flex flex-wrap items-center gap-0.5 text-ink-muted">
            {['Repository', ...folder.split('/').filter(Boolean)].map(
              (part, index, parts) => {
                const target = parts.slice(1, index + 1).join('/')
                return (
                  <span
                    key={target || 'repository'}
                    className="flex items-center"
                  >
                    {index > 0 && <span className="text-ink-subtle">/</span>}
                    <button
                      type="button"
                      className="rounded-sm px-1.5 py-1 font-medium outline-none hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-primary/40"
                      onClick={() => setFolder(target)}
                      onDragOver={(event) => {
                        if (
                          !event.dataTransfer.types.includes(
                            'application/x-loom-assets'
                          )
                        )
                          return
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'move'
                      }}
                      onDrop={(event) => dropInto(event, target)}
                    >
                      {part}
                    </button>
                  </span>
                )
              }
            )}
          </div>
          {dirs.map((d) => (
            <button
              className="block w-full rounded-sm px-2 py-1.5 text-left text-ink outline-none hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-primary/40"
              type="button"
              key={d}
              onClick={() => setFolder([folder, d].filter(Boolean).join('/'))}
              onDragOver={(event) => {
                if (
                  !event.dataTransfer.types.includes(
                    'application/x-loom-assets'
                  )
                )
                  return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(event) =>
                dropInto(event, [folder, d].filter(Boolean).join('/'))
              }
            >
              📁 {d}
            </button>
          ))}
        </div>
      )}
      <div className="px-2 pb-1 text-[11px] text-ink-subtle">
        {rows.length} asset{rows.length === 1 ? '' : 's'}
      </div>
      <div
        role="listbox"
        aria-label="Assets"
        aria-multiselectable="true"
        className="min-h-0 flex-1 overflow-auto"
      >
        {rows.length === 0 && (
          <div className="px-3 py-6 text-center text-[11.5px] leading-relaxed text-ink-muted">
            {mode === 'folders'
              ? 'No assets in this folder.'
              : search || status !== 'active' || placement || tagId
                ? 'No assets match these filters.'
                : 'No assets yet. Import files or rescan the repository.'}
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
            onClick={(e) => {
              select(
                selectAsset(
                  selected,
                  row.id,
                  rows.map((r) => r.id),
                  anchor.current,
                  e.shiftKey,
                  e.ctrlKey || e.metaKey
                )
              )
              if (!e.shiftKey) anchor.current = row.id
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              if (!selected.includes(row.id)) {
                select([row.id])
                anchor.current = row.id
              }
              setItemMenu({
                x: event.clientX,
                y: event.clientY,
                assetIds: selected.includes(row.id) ? selected : [row.id],
              })
            }}
            onDragStart={(e) => {
              const ids = selected.includes(row.id) ? selected : [row.id]
              select(ids)
              e.dataTransfer.setData(
                'application/x-loom-assets',
                JSON.stringify(ids)
              )
              e.dataTransfer.effectAllowed = 'copyMove'
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
      {itemMenu && (
        <div
          role="menu"
          className="fixed z-50 min-w-44 rounded-lg border border-black/8 bg-white p-1.5 shadow-lg"
          style={{ left: itemMenu.x, top: itemMenu.y }}
        >
          {renaming ? (
            <form
              className="grid w-56 gap-1.5 p-1"
              onSubmit={(event) => {
                event.preventDefault()
                const input = event.currentTarget.elements.namedItem(
                  'rename-file'
                ) as HTMLInputElement
                renameAsset(renaming.id, input.value.trim())
                setRenaming(null)
                setItemMenu(null)
              }}
            >
              <label
                htmlFor="rename-file"
                className="text-[11px] font-semibold text-ink-muted"
              >
                Rename file
              </label>
              <input
                id="rename-file"
                name="rename-file"
                aria-label="Rename file"
                defaultValue={renaming.name}
                className={fieldClass}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setRenaming(null)
                  }
                }}
              />
              <div className="flex justify-end gap-1">
                <button
                  type="button"
                  className="rounded-sm px-2 py-1.5 text-[12px] text-ink-muted hover:bg-black/[0.04]"
                  onClick={() => setRenaming(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-sm bg-primary px-2 py-1.5 text-[12px] font-semibold text-white"
                >
                  Rename
                </button>
              </div>
            </form>
          ) : (
            <>
              {mode === 'folders' && itemMenu.assetIds.length === 1 && (
                <button
                  type="button"
                  className="block w-full rounded-md px-3 py-2 text-left text-[12.5px] text-ink hover:bg-black/[0.04]"
                  onClick={() => {
                    const [id] = itemMenu.assetIds
                    const row = rows.find((item) => item.id === id)
                    if (row) setRenaming({ id, name: row.fileName })
                  }}
                >
                  Rename…
                </button>
              )}
              <button
                type="button"
                className="block w-full rounded-md px-3 py-2 text-left text-[12.5px] text-ink hover:bg-black/[0.04]"
                onClick={() => {
                  const ids = itemMenu.assetIds
                  setItemMenu(null)
                  compress(ids)
                }}
              >
                Compress…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
