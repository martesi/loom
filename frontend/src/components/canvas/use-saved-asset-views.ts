import { t } from '@lingui/core/macro'
import { useEffect, useRef, useState } from 'react'
import { SettingsService } from '../../../bindings/loom/internal/service'
import {
  type AssetView,
  InvalidAssetViewsError,
  parseAssetViews,
  serializeAssetViews,
} from '../../lib/asset-views'

const SETTING_KEY = 'assets.saved_views'
const DEFAULT_VIEW_ID = 'default-recent'

interface SaveResult {
  views: AssetView[]
  selectedId: string
}

export function useSavedAssetViews(
  path: string,
  onError: (error: unknown) => void
) {
  const [savedViews, setSavedViews] = useState<AssetView[]>([])
  const [viewsLoaded, setViewsLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'saving' | 'saved' | null>(null)
  const [loadRequest, setLoadRequest] = useState(0)
  const savedViewsRef = useRef<AssetView[]>([])
  const loadedRef = useRef(false)
  const writeQueue = useRef<Promise<void>>(Promise.resolve())
  const pendingWrites = useRef(0)
  const errorHandler = useRef(onError)
  errorHandler.current = onError

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadRequest intentionally retriggers a failed settings read.
  useEffect(() => {
    let cancelled = false
    loadedRef.current = false
    setViewsLoaded(false)
    setLoadError(false)
    void SettingsService.Get(path, SETTING_KEY)
      .then((value) => {
        if (cancelled) return
        const views = value ? parseAssetViews(value) : []
        savedViewsRef.current = views
        loadedRef.current = true
        setSavedViews(views)
        setViewsLoaded(true)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        loadedRef.current = false
        setLoadError(true)
        errorHandler.current(
          error instanceof InvalidAssetViewsError
            ? new Error(
                t`Saved views could not be loaded because the saved data is invalid.`
              )
            : error
        )
      })
    return () => {
      cancelled = true
    }
  }, [path, loadRequest])

  function retryLoad() {
    setLoadRequest((request) => request + 1)
  }

  function enqueueWrite(
    update: (current: AssetView[]) => SaveResult,
    onSaved: (selectedId: string) => void
  ) {
    if (!loadedRef.current) return
    pendingWrites.current += 1
    setSaveStatus('saving')
    writeQueue.current = writeQueue.current
      .then(() => {
        const { views, selectedId } = update(savedViewsRef.current)
        return SettingsService.Set(
          path,
          SETTING_KEY,
          serializeAssetViews(views)
        ).then(() => {
          savedViewsRef.current = views
          setSavedViews(views)
          onSaved(selectedId)
        })
      })
      .then(() => {
        pendingWrites.current -= 1
        setSaveStatus(pendingWrites.current ? 'saving' : 'saved')
      })
      .catch((error: unknown) => {
        pendingWrites.current = Math.max(0, pendingWrites.current - 1)
        setSaveStatus(pendingWrites.current ? 'saving' : null)
        errorHandler.current(error)
      })
  }

  function saveView(view: AssetView, onSaved: (id: string) => void) {
    enqueueWrite((current) => {
      const existing = current.find((candidate) => candidate.id === view.id)
      if (
        current.some(
          (candidate) =>
            candidate.id !== existing?.id &&
            candidate.name.toLocaleLowerCase() === view.name.toLocaleLowerCase()
        )
      )
        throw new Error(t`A saved view with that name already exists`)
      const next = existing
        ? current.map((candidate) =>
            candidate.id === existing.id ? view : candidate
          )
        : [...current, view]
      return { views: next, selectedId: view.id }
    }, onSaved)
  }

  function deleteView(id: string, onDeleted: (id: string) => void) {
    enqueueWrite(
      (current) => ({
        views: current.filter((view) => view.id !== id),
        selectedId: DEFAULT_VIEW_ID,
      }),
      onDeleted
    )
  }

  return {
    savedViews,
    viewsLoaded,
    loadError,
    saveStatus,
    retryLoad,
    saveView,
    deleteView,
  }
}
