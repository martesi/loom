import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import type { DragEvent, RefObject } from 'react'
import type { AssetLayout, AssetSort, AssetView } from '../../lib/asset-views'
import { Button } from '../ui/button'
import { AssetViewControls } from './asset-view-controls'
import { FolderNavigator } from './folder-navigator'

const fieldClass =
  'h-8 w-full rounded-sm border border-input bg-card px-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

interface Props {
  mode: string
  views: AssetView[]
  savedViewIds: Set<string>
  selectedViewId: string
  viewsLoaded: boolean
  viewsLoadError: boolean
  saveStatus: 'saving' | 'saved' | null
  sort: AssetSort
  layout: AssetLayout
  galleryDensity: number
  imageFit: 'cover' | 'contain'
  overlays: {
    filename: boolean
    dimensions: boolean
    tags: boolean
    prompt: boolean
  }
  onSelectView: (id: string) => void
  onRetryLoad: () => void
  onSaveView: (id: string, name: string) => void
  onDeleteView: (id: string) => void
  onSortChange: (sort: AssetSort) => void
  onLayoutChange: (layout: AssetLayout) => void
  onDensityChange: (density: number) => void
  onFitChange: (fit: 'cover' | 'contain') => void
  onOverlayChange: (key: keyof Props['overlays'], checked: boolean) => void
  searchRef: RefObject<HTMLInputElement | null>
  search: string
  onSearchChange: (value: string) => void
  filtersOpen: boolean
  onFiltersOpenChange: (update: (open: boolean) => boolean) => void
  status: string
  onStatusChange: (value: string) => void
  pairing: string
  onPairingChange: (value: string) => void
  tagId: number
  onTagChange: (value: number) => void
  tags: { id: number; name: string }[]
  activeFilterCount: number
  tagName: string | undefined
  folder: string
  dirs: string[]
  onFolderChange: (folder: string) => void
  onDropInto: (event: DragEvent, folder: string) => void
}

export function LibraryFilterControls(props: Props) {
  const {
    mode,
    views,
    savedViewIds,
    selectedViewId,
    viewsLoaded,
    viewsLoadError,
    saveStatus,
    sort,
    layout,
    galleryDensity,
    imageFit,
    overlays,
    onSelectView,
    onRetryLoad,
    onSaveView,
    onDeleteView,
    onSortChange,
    onLayoutChange,
    onDensityChange,
    onFitChange,
    onOverlayChange,
    searchRef,
    search,
    onSearchChange,
    filtersOpen,
    onFiltersOpenChange,
    status,
    onStatusChange,
    pairing,
    onPairingChange,
    tagId,
    onTagChange,
    tags,
    activeFilterCount,
    tagName,
    folder,
    dirs,
    onFolderChange,
    onDropInto,
  } = props
  return (
    <>
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
            onSelectView={onSelectView}
            onRetryLoad={onRetryLoad}
            onSaveView={onSaveView}
            onDeleteView={onDeleteView}
            onSortChange={onSortChange}
            onLayoutChange={onLayoutChange}
            onDensityChange={onDensityChange}
            onFitChange={onFitChange}
            onOverlayChange={onOverlayChange}
          />
          <div className="flex gap-1.5">
            <input
              ref={searchRef}
              className={fieldClass}
              aria-label={t`Search assets`}
              placeholder={t`Search assets`}
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
            />
            <button
              type="button"
              aria-expanded={filtersOpen}
              onClick={() => onFiltersOpenChange((open) => !open)}
              className="h-8 shrink-0 rounded-sm border border-input px-2.5 font-semibold text-ink-muted outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <Trans>Filters</Trans>
              {activeFilterCount > 0 && <> {activeFilterCount}</>}
            </button>
          </div>
          {filtersOpen && (
            <div className="grid gap-1.5 rounded-md border border-border bg-muted p-2">
              <select
                className={fieldClass}
                aria-label={t`Asset state`}
                value={status}
                onChange={(e) => onStatusChange(e.target.value)}
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
                aria-label={t`Relationship`}
                value={pairing}
                onChange={(e) => onPairingChange(e.target.value)}
              >
                <option value="">
                  <Trans>All relationships</Trans>
                </option>
                <option value="paired">
                  <Trans>paired</Trans>
                </option>
                <option value="unpaired">
                  <Trans>unpaired</Trans>
                </option>
              </select>
              <select
                className={fieldClass}
                aria-label={t`Tag filter`}
                value={tagId}
                onChange={(e) => onTagChange(Number(e.target.value))}
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
            <div className="flex flex-wrap items-center gap-1">
              {search && (
                <Button
                  type="button"
                  aria-label={t`Remove search filter: ${search}`}
                  onClick={() => onSearchChange('')}
                  variant="ghost"
                  size="sm"
                  className="h-auto rounded-full bg-primary-soft px-2 py-1 text-[11px] text-ink"
                >
                  {t`Search`}: {search} ×
                </Button>
              )}
              {status !== 'active' && (
                <Button
                  type="button"
                  aria-label={t`Remove asset state filter: ${status}`}
                  onClick={() => onStatusChange('active')}
                  variant="ghost"
                  size="sm"
                  className="h-auto rounded-full bg-primary-soft px-2 py-1 text-[11px] text-ink"
                >
                  {status === 'all' ? (
                    <Trans>All</Trans>
                  ) : status === 'active' ? (
                    <Trans>Active</Trans>
                  ) : status === 'archived' ? (
                    <Trans>Archived</Trans>
                  ) : status === 'trashed' ? (
                    <Trans>Trash</Trans>
                  ) : (
                    <Trans>Missing</Trans>
                  )}{' '}
                  ×
                </Button>
              )}
              {pairing && (
                <Button
                  type="button"
                  aria-label={t`Remove relationship filter: ${pairing}`}
                  onClick={() => onPairingChange('')}
                  variant="ghost"
                  size="sm"
                  className="h-auto rounded-full bg-primary-soft px-2 py-1 text-[11px] text-ink"
                >
                  {pairing === 'paired' ? (
                    <Trans>Paired</Trans>
                  ) : (
                    <Trans>Unpaired</Trans>
                  )}{' '}
                  ×
                </Button>
              )}
              {tagId > 0 && (
                <Button
                  type="button"
                  aria-label={t`Remove tag filter: ${tagName ?? 'Unavailable tag'}`}
                  onClick={() => onTagChange(0)}
                  variant="ghost"
                  size="sm"
                  className="h-auto rounded-full bg-primary-soft px-2 py-1 text-[11px] text-ink"
                >
                  {tagName ?? <Trans>Unavailable tag</Trans>} ×
                </Button>
              )}
              <Button
                type="button"
                onClick={() => {
                  onSearchChange('')
                  onStatusChange('active')
                  onPairingChange('')
                  onTagChange(0)
                }}
                variant="ghost"
                size="sm"
                className="h-auto rounded-full px-2 py-1 text-[11px] text-ink-muted underline"
              >
                <Trans>Clear filters</Trans>
              </Button>
            </div>
          )}
        </div>
      ) : (
        <FolderNavigator
          folder={folder}
          dirs={dirs}
          onFolderChange={onFolderChange}
          onDropInto={onDropInto}
        />
      )}
    </>
  )
}
