import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { AssetLayout, AssetSort, AssetView } from '../../lib/asset-views'
import { Tooltip } from '../ui/tooltip'

interface Props {
  views: AssetView[]
  savedViewIds: Set<string>
  selectedViewId: string
  viewsLoaded: boolean
  loadError: boolean
  saveStatus: 'saving' | 'saved' | null
  sort: AssetSort
  layout: AssetLayout
  density: number
  fit: 'cover' | 'contain'
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
}

const buttonClass =
  'h-7 rounded-sm border border-black/12 px-2 text-[11px] font-medium text-ink-muted outline-none hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-40'
const inputClass =
  'h-7 min-w-0 rounded-sm border border-black/12 bg-card px-2 text-[11px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

export function AssetViewControls(props: Props) {
  const [viewName, setViewName] = useState('')
  const selectedView = props.views.find(
    (view) => view.id === props.selectedViewId
  )
  const isSavedView = props.savedViewIds.has(props.selectedViewId)

  useEffect(() => {
    setViewName(isSavedView ? (selectedView?.name ?? '') : '')
  }, [isSavedView, selectedView?.name])

  return (
    <div className="grid gap-2 border-b border-border p-2">
      {props.loadError ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 text-[10px] text-danger"
        >
          <Trans>Saved views could not be loaded.</Trans>
          <button
            type="button"
            className={buttonClass}
            onClick={props.onRetryLoad}
          >
            <Trans>Retry</Trans>
          </button>
        </div>
      ) : !props.viewsLoaded ? (
        <span role="status" className="text-[10px] text-ink-muted">
          <Trans>Loading saved views…</Trans>
        </span>
      ) : null}
      <div className="flex gap-1.5">
        <select
          aria-label={t`Saved asset view`}
          className={`${inputClass} min-w-0 flex-1`}
          value={props.selectedViewId}
          disabled={!props.viewsLoaded || props.saveStatus === 'saving'}
          onChange={(event) => props.onSelectView(event.target.value)}
        >
          {props.views.map((view) => (
            <option key={view.id} value={view.id}>
              {view.id === 'default-recent'
                ? t`Recent`
                : view.id === 'default-unplaced'
                  ? t`Unplaced`
                  : view.name}
            </option>
          ))}
        </select>
        {isSavedView && (
          <button
            type="button"
            aria-label={t`Delete saved view`}
            className={buttonClass}
            disabled={!props.viewsLoaded || props.saveStatus === 'saving'}
            onClick={() => props.onDeleteView(props.selectedViewId)}
          >
            <Trans>Delete</Trans>
          </button>
        )}
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-1.5">
        <input
          aria-label={t`Saved view name`}
          className={inputClass}
          placeholder={t`Name this view`}
          value={viewName}
          onChange={(event) => setViewName(event.target.value)}
        />
        <button
          type="button"
          className={buttonClass}
          disabled={
            !viewName.trim() ||
            !props.viewsLoaded ||
            props.saveStatus === 'saving'
          }
          onClick={() =>
            props.onSaveView(props.selectedViewId, viewName.trim())
          }
        >
          {isSavedView ? <Trans>Save changes</Trans> : <Trans>Save view</Trans>}
        </button>
      </div>
      {props.saveStatus && (
        <span role="status" className="text-[10px] text-ink-muted">
          {props.saveStatus === 'saving' ? (
            <Trans>Saving view…</Trans>
          ) : (
            <Trans>View saved</Trans>
          )}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <Tooltip label={t`Gallery view`} shortcut="Mod+Shift+1">
          <button
            type="button"
            aria-label={t`Gallery view`}
            aria-pressed={props.layout === 'gallery'}
            className={`${buttonClass} aria-pressed:bg-primary-soft aria-pressed:text-ink`}
            onClick={() => props.onLayoutChange('gallery')}
          >
            ▦
          </button>
        </Tooltip>
        <Tooltip label={t`List view`} shortcut="Mod+Shift+2">
          <button
            type="button"
            aria-label={t`List view`}
            aria-pressed={props.layout === 'list'}
            className={`${buttonClass} aria-pressed:bg-primary-soft aria-pressed:text-ink`}
            onClick={() => props.onLayoutChange('list')}
          >
            ☷
          </button>
        </Tooltip>
        {props.layout === 'gallery' && (
          <>
            <span className="mx-1 h-4 border-l border-border" />
            <Tooltip
              label={t`Smaller gallery cards`}
              shortcut="Mod+Alt+ArrowDown"
            >
              <button
                type="button"
                aria-label={t`Smaller gallery cards`}
                className={buttonClass}
                disabled={props.density === 0}
                onClick={() =>
                  props.onDensityChange(Math.max(0, props.density - 1))
                }
              >
                −
              </button>
            </Tooltip>
            <span className="px-1 text-[10px] text-ink-muted">
              <Trans>Size</Trans> {props.density + 1}
            </span>
            <Tooltip label={t`Larger gallery cards`} shortcut="Mod+Alt+ArrowUp">
              <button
                type="button"
                aria-label={t`Larger gallery cards`}
                className={buttonClass}
                disabled={props.density === 2}
                onClick={() =>
                  props.onDensityChange(Math.min(2, props.density + 1))
                }
              >
                +
              </button>
            </Tooltip>
          </>
        )}
        <select
          aria-label={t`Sort assets`}
          className={`${inputClass} ml-auto`}
          value={props.sort}
          onChange={(event) =>
            props.onSortChange(event.target.value as AssetSort)
          }
        >
          <option value="recent">{t`Newest first`}</option>
          <option value="oldest">{t`Oldest first`}</option>
          <option value="name-asc">{t`Name A to Z`}</option>
          <option value="name-desc">{t`Name Z to A`}</option>
        </select>
      </div>
      {props.layout === 'gallery' && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink-muted">
          <label className="flex items-center gap-1">
            <span>
              <Trans>Image fit</Trans>
            </span>
            <select
              aria-label={t`Image fit`}
              className={inputClass}
              value={props.fit}
              onChange={(event) =>
                props.onFitChange(event.target.value as 'cover' | 'contain')
              }
            >
              <option value="cover">{t`Crop`}</option>
              <option value="contain">{t`Fit`}</option>
            </select>
          </label>
          {(
            [
              ['filename', t`Filename`],
              ['dimensions', t`Dimensions`],
              ['tags', t`Tags`],
              ['prompt', t`Prompt`],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={props.overlays[key]}
                onChange={(event) =>
                  props.onOverlayChange(key, event.target.checked)
                }
              />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
