import { useEffect, useRef, useState } from 'react'
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
}
export function LibraryPanel({
  path,
  selection,
  select,
  refresh,
  onError,
  visible,
  reveal,
}: Props) {
  const [mode, setMode] = useState('all'),
    [folder, setFolder] = useState(''),
    [search, setSearch] = useState(''),
    [status, setStatus] = useState('active'),
    [placement, setPlacement] = useState(''),
    [tagId, setTagId] = useState(0)
  const [rows, setRows] = useState<LibraryRow[]>([]),
    [dirs, setDirs] = useState<string[]>([]),
    [tags, setTags] = useState<{ id: number; name: string }[]>([])
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
  const selected = selection.surface === 'assets' ? selection.ids : []
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
          <input
            className={fieldClass}
            aria-label="Search assets"
            placeholder="Search assets"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className={fieldClass}
            aria-label="Asset state"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {['active', 'all', 'archived', 'trashed', 'missing'].map((s) => (
              <option key={s}>{s}</option>
            ))}
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
      ) : (
        <div className="p-2">
          <button
            type="button"
            className="max-w-full rounded-sm px-2 py-1.5 text-left font-medium text-ink-muted outline-none hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-primary/40"
            onClick={() => setFolder(folder.split('/').slice(0, -1).join('/'))}
          >
            ↑ Repository / {folder}
          </button>
          {dirs.map((d) => (
            <button
              className="block w-full rounded-sm px-2 py-1.5 text-left text-ink outline-none hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-primary/40"
              type="button"
              key={d}
              onClick={() => setFolder([folder, d].filter(Boolean).join('/'))}
            >
              📁 {d}
            </button>
          ))}
        </div>
      )}
      <div
        role="listbox"
        aria-label="Assets"
        aria-multiselectable="true"
        className="min-h-0 flex-1 overflow-auto"
      >
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
            onDragStart={(e) => {
              const ids = selected.includes(row.id) ? selected : [row.id]
              select(ids)
              e.dataTransfer.setData(
                'application/x-loom-assets',
                JSON.stringify(ids)
              )
              e.dataTransfer.effectAllowed = 'copy'
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
    </div>
  )
}
