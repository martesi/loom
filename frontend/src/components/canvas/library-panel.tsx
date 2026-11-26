import { plural } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { type DragEvent, memo, useEffect, useRef, useState } from 'react'
import {
  ImageService,
  type LibraryRow,
  LibraryService,
  TagService,
} from '../../../bindings/loom/internal/service'
import { parseAssetDragPayload } from '../../lib/asset-drag-payload'
import {
  type AssetLayout,
  type AssetSort,
  type AssetView,
  DEFAULT_ASSET_VIEWS,
  matchesAssetView,
  sortAssetRows,
} from '../../lib/asset-views'
import { renditionGenerationUrl } from '../../lib/preview-tier'
import type { Selection } from '../../lib/selection'
import { Button } from '../ui/button'
import { AssetGallery } from './asset-gallery'
import { AssetList } from './asset-list'
import type { CanvasBoardOwner } from './canvas-board-owner'
import { unwrapCanvasOutcome } from './canvas-operation'
import { canvasEffects } from './canvas-operation-effects'
import {
  type AssetContextMenuState,
  LibraryContextMenu,
} from './library-context-menu'
import { LibraryFilterControls } from './library-filter-controls'
import { useSavedAssetViews } from './use-saved-asset-views'

interface Props {
  owner: CanvasBoardOwner
  path: string
  selection: Selection
  select: (ids: number[]) => void
  refresh: number
  renditionGeneration: number
  onError: (e: unknown) => void
  visible: (ids: number[]) => void
  reveal: { id: number; folder: string | null } | null
  compress: (ids: number[]) => void
  searchFocusRequest: number
  navigatorModeRequest: {
    mode: 'all' | 'folders'
    layout?: AssetLayout
    densityDelta?: -1 | 1
    request: number
  } | null
  onShowCommands: () => void
  // Opens the preview rooted at an asset row. `orderedIds` is the
  // ListDirectory file order captured alongside the current folder listing;
  // the route uses it to build the folder carousel.
  onPreview: (imageId: number, folder: string, orderedIds: number[]) => void
}
// Memoized: the Canvas route re-renders on every node-drag pointermove, but
// all props here are referentially stable across drag frames (stable
// callbacks from the route, unchanged selection/data), so the library list
// is skipped while dragging.
export const LibraryPanel = memo(function LibraryPanel({
  owner,
  path,
  selection,
  select,
  refresh,
  renditionGeneration,
  onError,
  visible,
  reveal,
  compress,
  searchFocusRequest,
  navigatorModeRequest,
  onShowCommands,
  onPreview,
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
    [folderOrder, setFolderOrder] = useState<number[]>([]),
    [tags, setTags] = useState<{ id: number; name: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [retryCount, setRetryCount] = useState(0)
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
  const sortedRows = sortAssetRows(
    rows.map((row) => ({
      ...row,
      thumbUrl: renditionGenerationUrl(row.thumbUrl, renditionGeneration),
    })),
    sort
  )
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
    setSelectedViewId('default-recent')
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
      setLoading(true)
      setLoadError(false)
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
        // Capture the backend file order alongside the listing so a folder
        // preview can carousel in the same order ListDirectory returned.
        if (!cancelled) setFolderOrder((d?.files ?? []).map((file) => file.id))
        const ids = new Set(d?.files?.map((f) => f.id))
        list = list.filter((r) => ids.has(r.id))
      } else if (!cancelled) {
        setFolderOrder([])
      }
      if (!cancelled) {
        setRows(list)
        setLoading(false)
        callbacks.current.visible(sortAssetRows(list, sort).map((r) => r.id))
        if (selection.surface === 'assets') {
          const valid = new Set(list.map((row) => row.id))
          const reconciled = selection.ids.filter((id) => valid.has(id))
          if (reconciled.length !== selection.ids.length) select(reconciled)
        }
      }
    }
    void load().catch((error) => {
      if (!cancelled) {
        setLoading(false)
        setLoadError(true)
        setRows([])
        callbacks.current.onError(error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    path,
    mode,
    folder,
    search,
    status,
    placement,
    tagId,
    sort,
    refresh,
    retryCount,
  ])
  const selected = selection.surface === 'assets' ? selection.ids : []
  const activeFilterCount =
    Number(Boolean(search)) +
    Number(status !== 'active') +
    Number(Boolean(placement)) +
    Number(tagId > 0)
  const tagName = tags.find((tag) => tag.id === tagId)?.name
  async function moveAssets(ids: number[], targetFolder: string) {
    const uniqueIds = [...new Set(ids)]
    const outcome = await owner.submit(
      {
        kind: 'mutation',
        capability: 'metadata',
        board: owner.getSnapshot(),
      },
      async (context) => {
        const outcomes = await context.prepare(() =>
          Promise.allSettled(
            uniqueIds.map((id) => {
              const row = rows.find((item) => item.id === id)
              if (!row)
                return Promise.reject(
                  new Error(`Asset ${id} is not in the current folder`)
                )
              return canvasEffects.moveFile(
                context,
                path,
                id,
                [targetFolder, row.fileName].filter(Boolean).join('/')
              )
            })
          )
        )
        const failures = outcomes.flatMap((result, index) =>
          result.status === 'rejected'
            ? [{ id: uniqueIds[index], cause: result.reason }]
            : []
        )
        if (failures.length) {
          for (const failure of failures) {
            console.error('asset move failed', {
              assetId: failure.id,
              cause: failure.cause,
            })
          }
          const contexts = failures.map(
            ({ id, cause }) =>
              `Asset ${id}: ${cause instanceof Error ? cause.message : String(cause)}`
          )
          throw new Error(
            `${uniqueIds.length - failures.length} of ${uniqueIds.length} assets moved.${contexts.length ? ` ${contexts.join('; ')}` : ''} The current state was refreshed.`
          )
        }
      }
    )
    if (outcome.status === 'cancelled') return
    unwrapCanvasOutcome(outcome)
  }
  function dropInto(event: DragEvent, targetFolder: string) {
    const raw = event.dataTransfer.getData('application/x-loom-assets')
    if (!raw) return
    event.preventDefault()
    const payload = parseAssetDragPayload(raw)
    if (!payload) {
      onError(new Error('Invalid asset drag'))
      return
    }
    if (payload.repoPath !== path) {
      onError(new Error('This asset drag belongs to another repository'))
      return
    }
    void moveAssets(payload.ids, targetFolder).catch(onError)
  }
  function renameAsset(id: number, name: string) {
    if (/[\\/]/.test(name)) {
      onError(new Error('File name cannot contain / or \\'))
      return
    }
    void owner
      .submit(
        {
          kind: 'mutation',
          capability: 'metadata',
          board: owner.getSnapshot(),
        },
        async (context) => {
          const row = rows.find((item) => item.id === id)
          if (!row || !name || name === row.fileName) return
          await canvasEffects.moveFile(
            context,
            path,
            id,
            [folder, name].filter(Boolean).join('/')
          )
        }
      )
      .then((outcome) => {
        if (outcome.status === 'cancelled') return
        unwrapCanvasOutcome(outcome)
      })
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
      <LibraryFilterControls
        mode={mode}
        views={views}
        savedViewIds={savedViewIds}
        selectedViewId={selectedViewId}
        viewsLoaded={viewsLoaded}
        viewsLoadError={viewsLoadError}
        saveStatus={saveStatus}
        sort={sort}
        layout={layout}
        galleryDensity={galleryDensity}
        imageFit={imageFit}
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
        searchRef={searchInput}
        search={search}
        onSearchChange={setSearch}
        filtersOpen={filtersOpen}
        onFiltersOpenChange={setFiltersOpen}
        status={status}
        onStatusChange={setStatus}
        placement={placement}
        onPlacementChange={setPlacement}
        tagId={tagId}
        onTagChange={setTagId}
        tags={tags}
        activeFilterCount={activeFilterCount}
        tagName={tagName}
        folder={folder}
        dirs={dirs}
        onFolderChange={setFolder}
        onDropInto={dropInto}
      />
      <div className="px-2 pb-1 text-[11px] text-ink-subtle">
        <span>
          {plural(sortedRows.length, { one: '# asset', other: '# assets' })}
        </span>
        {
          <span className="ml-2">
            {plural(selected.length, {
              one: '# selected',
              other: '# selected',
            })}
          </span>
        }
        {sortedRows.length > 0 && !loading && !loadError && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-2 h-auto px-0 underline"
            onClick={() => select(sortedRows.map((row) => row.id))}
          >
            {mode === 'all' ? (
              <Trans>Select all results</Trans>
            ) : (
              <Trans>Select all files in folder</Trans>
            )}
          </Button>
        )}
      </div>
      {layout === 'gallery' && mode === 'all' && sortedRows.length > 0 ? (
        <AssetGallery
          path={path}
          rows={sortedRows}
          selected={selected}
          select={select}
          density={galleryDensity}
          fit={imageFit}
          overlays={overlays}
          onContextMenu={(assetIds, x, y) => setItemMenu({ assetIds, x, y })}
          reveal={reveal}
        />
      ) : (
        <AssetList
          path={path}
          rows={sortedRows}
          selected={selected}
          search={search}
          status={status}
          placement={placement}
          tagId={tagId}
          mode={mode}
          loading={loading}
          error={loadError}
          onRetry={() => setRetryCount((count) => count + 1)}
          onSelect={select}
          onContextMenu={(assetIds, x, y) => setItemMenu({ assetIds, x, y })}
          reveal={reveal}
          // Double-click previews from the folder view (single click stays
          // selection, matching the list's existing interaction). Gallery
          // only renders in 'all' mode, so only the list needs the hook.
          onPreview={
            mode === 'folders'
              ? (id) => onPreview(id, folder, folderOrder)
              : undefined
          }
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
})
