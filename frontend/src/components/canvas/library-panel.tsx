import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { type DragEvent, useEffect, useRef, useState } from 'react'
import {
  ImageService,
  type LibraryRow,
  LibraryService,
  TagService,
} from '../../../bindings/loom/internal/service'
import {
  type AssetLayout,
  type AssetSort,
  type AssetView,
  DEFAULT_ASSET_VIEWS,
  matchesAssetView,
  sortAssetRows,
} from '../../lib/asset-views'
import type { Selection } from '../../lib/selection'
import { AssetGallery } from './asset-gallery'
import { AssetList } from './asset-list'
import { AssetViewControls } from './asset-view-controls'
import { FolderNavigator } from './folder-navigator'
import {
  type AssetContextMenuState,
  LibraryContextMenu,
} from './library-context-menu'
import { useSavedAssetViews } from './use-saved-asset-views'

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
  searchFocusRequest: number
  navigatorModeRequest: {
    mode: 'all' | 'folders'
    layout?: AssetLayout
    densityDelta?: -1 | 1
    request: number
  } | null
  onShowCommands: () => void
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
  searchFocusRequest,
  navigatorModeRequest,
  onShowCommands,
}: Props) {
  const [mode, setMode] = useState('all'),
    [folder, setFolder] = useState(''),
    [search, setSearch] = useState(''),
    [status, setStatus] = useState('active'),
    [placement, setPlacement] = useState(''),
    [tagId, setTagId] = useState(0),
    [filtersOpen, setFiltersOpen] = useState(false)
  const [layout, setLayout] = useState<AssetLayout>('list')
  const [sort, setSort] = useState<AssetSort>('recent')
  const [selectedViewId, setSelectedViewId] = useState('default-recent')
  const [galleryDensity, setGalleryDensity] = useState(1)
  const [imageFit, setImageFit] = useState<'cover' | 'contain'>('cover')
  const [overlays, setOverlays] = useState({
    filename: true,
    dimensions: true,
    tags: false,
    prompt: false,
  })
  const [rows, setRows] = useState<LibraryRow[]>([]),
    [dirs, setDirs] = useState<string[]>([]),
    [tags, setTags] = useState<{ id: number; name: string }[]>([])
  const [itemMenu, setItemMenu] = useState<AssetContextMenuState | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const callbacks = useRef({ onError, visible })
  callbacks.current = { onError, visible }
  const {
    savedViews,
    viewsLoaded,
    loadError: viewsLoadError,
    saveStatus,
    retryLoad,
    saveView,
    deleteView,
  } = useSavedAssetViews(path, onError)
  const views = [...DEFAULT_ASSET_VIEWS, ...savedViews]
  const savedViewIds = new Set(savedViews.map((view) => view.id))
  const currentView: AssetView = {
    id: selectedViewId,
    name: views.find((view) => view.id === selectedViewId)?.name ?? '',
    search,
    status: status as AssetView['status'],
    placement: placement as AssetView['placement'],
    tagId,
    sort,
    layout,
  }
  const sortedRows = sortAssetRows(rows, sort)
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
  useEffect(() => {
    if (!navigatorModeRequest) return
    setMode(navigatorModeRequest.mode)
    if (navigatorModeRequest.layout) setLayout(navigatorModeRequest.layout)
    const densityDelta = navigatorModeRequest.densityDelta
    if (densityDelta !== undefined)
      setGalleryDensity((density) =>
        Math.max(0, Math.min(2, density + densityDelta))
      )
  }, [navigatorModeRequest])
  useEffect(() => {
    if (!searchFocusRequest) return
    setMode('all')
    requestAnimationFrame(() => searchInput.current?.focus())
  }, [searchFocusRequest])
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
        (row) => mode === 'folders' || matchesAssetView(row, currentView)
      )
      if (mode === 'folders') {
        const d = await ImageService.ListDirectory(path, folder)
        if (!cancelled) setDirs(d?.dirs ?? [])
        const ids = new Set(d?.files?.map((f) => f.id))
        list = list.filter((r) => ids.has(r.id))
      }
      if (!cancelled) {
        setRows(list)
        callbacks.current.visible(sortAssetRows(list, sort).map((r) => r.id))
      }
    }
    void load().catch(callbacks.current.onError)
    return () => {
      cancelled = true
    }
  }, [path, mode, folder, search, status, placement, tagId, sort, refresh])
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
  function saveAssetView(id: string, name: string) {
    if (!viewsLoaded) return
    const saved: AssetView = {
      ...currentView,
      id: savedViewIds.has(id) ? id : crypto.randomUUID(),
      name,
    }
    saveView(saved, setSelectedViewId)
  }
  function selectAssetView(id: string) {
    const view = views.find((candidate) => candidate.id === id)
    if (!view) return
    setSelectedViewId(id)
    setMode('all')
    setSearch(view.search)
    setStatus(view.status)
    setPlacement(view.placement)
    setTagId(view.tagId)
    setSort(view.sort)
    setLayout(view.layout)
  }
  function deleteAssetView(id: string) {
    if (!viewsLoaded || !savedViewIds.has(id)) return
    deleteView(id, selectAssetView)
  }
  function setOverlay(key: keyof typeof overlays, checked: boolean) {
    setOverlays((current) => ({ ...current, [key]: checked }))
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
            {m === 'all' ? <Trans>All Assets</Trans> : <Trans>Folders</Trans>}
          </button>
        ))}
      </div>
      {mode === 'all' ? (
        <div className="grid gap-2 p-2">
          <AssetViewControls
            views={views}
            savedViewIds={savedViewIds}
            selectedViewId={selectedViewId}
            viewsLoaded={viewsLoaded}
            loadError={viewsLoadError}
            saveStatus={saveStatus}
            sort={sort}
            layout={layout}
            density={galleryDensity}
            fit={imageFit}
            overlays={overlays}
            onSelectView={selectAssetView}
            onRetryLoad={retryLoad}
            onSaveView={saveAssetView}
            onDeleteView={deleteAssetView}
            onSortChange={setSort}
            onLayoutChange={setLayout}
            onDensityChange={setGalleryDensity}
            onFitChange={setImageFit}
            onOverlayChange={setOverlay}
          />
          <div className="flex gap-1.5">
            <input
              ref={searchInput}
              className={fieldClass}
              aria-label={t`Search assets`}
              placeholder={t`Search assets`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              type="button"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((open) => !open)}
              className="h-8 shrink-0 rounded-sm border border-black/12 px-2.5 font-semibold text-ink-muted outline-none hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <Trans>Filters</Trans>
              {activeFilterCount > 0 && <> {activeFilterCount}</>}
            </button>
          </div>
          {filtersOpen && (
            <div className="grid gap-1.5 rounded-md border border-black/6 bg-black/[0.015] p-2">
              <select
                className={fieldClass}
                aria-label={t`Asset state`}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="active">
                  <Trans>active</Trans>
                </option>
                <option value="all">
                  <Trans>all</Trans>
                </option>
                <option value="archived">
                  <Trans>archived</Trans>
                </option>
                <option value="trashed">
                  <Trans>trashed</Trans>
                </option>
                <option value="missing">
                  <Trans>missing</Trans>
                </option>
              </select>
              <select
                className={fieldClass}
                aria-label={t`Placement`}
                value={placement}
                onChange={(e) => setPlacement(e.target.value)}
              >
                <option value="">
                  <Trans>All placements</Trans>
                </option>
                <option value="placed">
                  <Trans>placed</Trans>
                </option>
                <option value="unplaced">
                  <Trans>unplaced</Trans>
                </option>
              </select>
              <select
                className={fieldClass}
                aria-label={t`Tag filter`}
                value={tagId}
                onChange={(e) => setTagId(Number(e.target.value))}
              >
                <option value={0}>
                  <Trans>All tags</Trans>
                </option>
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
        <FolderNavigator
          folder={folder}
          dirs={dirs}
          onFolderChange={setFolder}
          onDropInto={dropInto}
        />
      )}
      <div className="px-2 pb-1 text-[11px] text-ink-subtle">
        {plural(sortedRows.length, { one: '# asset', other: '# assets' })}
      </div>
      {layout === 'gallery' && mode === 'all' ? (
        <AssetGallery
          rows={sortedRows}
          selected={selected}
          select={select}
          density={galleryDensity}
          fit={imageFit}
          overlays={overlays}
          onContextMenu={(assetIds, x, y) => setItemMenu({ assetIds, x, y })}
        />
      ) : (
        <AssetList
          rows={sortedRows}
          selected={selected}
          search={search}
          status={status}
          placement={placement}
          tagId={tagId}
          mode={mode}
          onSelect={select}
          onContextMenu={(assetIds, x, y) => setItemMenu({ assetIds, x, y })}
        />
      )}
      <LibraryContextMenu
        menu={itemMenu}
        mode={mode}
        rows={rows}
        onClose={() => setItemMenu(null)}
        onRename={renameAsset}
        onCompress={compress}
        onShowCommands={onShowCommands}
      />
    </div>
  )
}
