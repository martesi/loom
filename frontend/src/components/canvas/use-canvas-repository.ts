import type { ReactFlowInstance } from '@xyflow/react'
import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import {
  type CanvasData,
  type ImageInfo,
  ImageService,
} from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import type {
  CanvasBoardOwner,
  CanvasOperationIntent,
} from './canvas-board-owner'
import { readCanvasModeViewport } from './canvas-mode-viewport'
import type { CanvasSelectionIntentRef } from './canvas-selection-intent'

interface AssetSelectionRecords {
  key: string
  records: ImageInfo[]
}

interface Props {
  repoPath: string
  modeViewports?: boolean
  executor: CanvasBoardOwner
  flow: ReactFlowInstance
  updateZoomCompensation: (zoom: number) => void
  selection: Selection
  selectionIntentRef?: CanvasSelectionIntentRef
  refresh: number
  setRefresh: Dispatch<SetStateAction<number>>
  setError: Dispatch<SetStateAction<string>>
  setReady: Dispatch<SetStateAction<boolean>>
  setAssetSelectionRecords: Dispatch<SetStateAction<AssetSelectionRecords>>
}

export function useCanvasRepository({
  repoPath,
  modeViewports = false,
  executor,
  flow,
  updateZoomCompensation,
  selection,
  selectionIntentRef,
  refresh,
  setRefresh,
  setError,
  setReady,
  setAssetSelectionRecords,
}: Props) {
  const fallbackSelectionIntent = useRef({
    current: { key: '', revision: 0, targetRevision: 0 },
  })
  const currentSelectionIntent =
    selectionIntentRef ?? fallbackSelectionIntent.current
  const report = useCallback(
    (error: unknown) => {
      console.error('canvas operation failed', error)
      setError(error instanceof Error ? error.message : String(error))
    },
    [setError]
  )
  const reload = useCallback(async (): Promise<void> => {
    await executor.refresh()
  }, [executor])
  const reloadForData = useCallback(async (): Promise<CanvasData | null> => {
    const result = await executor.refresh()
    return result?.data ?? null
  }, [executor])
  useEffect(
    () => executor.subscribe(() => setRefresh((current) => current + 1)),
    [executor, setRefresh]
  )
  const assetSelectionKey =
    selection.surface === 'assets' && selection.ids.length
      ? `${refresh}:${selection.ids.join(',')}`
      : ''
  useEffect(() => {
    if (!assetSelectionKey) {
      setAssetSelectionRecords({ key: '', records: [] })
      return
    }
    let cancelled = false
    const ids = assetSelectionKey.split(':', 2)[1]?.split(',').map(Number) ?? []
    void Promise.all(ids.map((id) => ImageService.GetImage(repoPath, id)))
      .then((images) => {
        if (cancelled) return
        setAssetSelectionRecords({
          key: assetSelectionKey,
          records: images.filter((image): image is ImageInfo => image !== null),
        })
      })
      .catch(report)
    return () => {
      cancelled = true
    }
  }, [assetSelectionKey, repoPath, report, setAssetSelectionRecords])
  const run = useCallback(
    (
      action: () => Promise<unknown>,
      guard?: () => boolean,
      intent?: CanvasOperationIntent
    ) => {
      const revision = currentSelectionIntent.current.revision
      const targetRevision = currentSelectionIntent.current.targetRevision
      const operationIntent =
        intent ?? executor.captureIntent('relationship', revision)
      const isCurrent = () =>
        (guard?.() ?? true) &&
        currentSelectionIntent.current.revision ===
          operationIntent.userIntentRevision &&
        currentSelectionIntent.current.targetRevision === targetRevision
      void executor
        .executeIntent(operationIntent, isCurrent, action, true)
        .catch(report)
    },
    [executor, report, currentSelectionIntent]
  )
  useEffect(() => {
    let cancelled = false
    const isCurrent = () =>
      !cancelled &&
      executor.repoPath === repoPath &&
      executor.isActive?.() !== false
    void ImageService.GetViewport(repoPath)
      .then(async (viewport) => {
        if (!isCurrent()) return null
        executor.setRepositoryViewport(viewport)
        const initialView = modeViewports
          ? (readCanvasModeViewport(repoPath, 'view') ?? viewport)
          : viewport
        if (initialView) updateZoomCompensation(initialView.zoom)
        if (viewport && !modeViewports) await flow.setViewport(viewport)
        if (!isCurrent()) return null
        return executor.refresh()
      })
      .then(() => {
        if (!isCurrent()) return
        setReady(true)
      })
      .catch((error) => {
        if (!cancelled) report(error)
      })
    return () => {
      cancelled = true
    }
  }, [
    executor,
    modeViewports,
    repoPath,
    flow,
    updateZoomCompensation,
    setReady,
    report,
  ])
  return { report, reload, reloadForData, run, assetSelectionKey }
}
