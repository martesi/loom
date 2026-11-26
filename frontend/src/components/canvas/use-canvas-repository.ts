import type { ReactFlowInstance } from '@xyflow/react'
import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import {
  type CanvasData,
  type ImageInfo,
  ImageService,
} from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import type { CanvasBoardOwner } from './canvas-board-owner'

interface AssetSelectionRecords {
  key: string
  records: ImageInfo[]
}

interface Props {
  repoPath: string
  executor: CanvasBoardOwner
  flow: ReactFlowInstance
  updateZoomCompensation: (zoom: number) => void
  selection: Selection
  refresh: number
  setRefresh: Dispatch<SetStateAction<number>>
  setError: Dispatch<SetStateAction<string>>
  setReady: Dispatch<SetStateAction<boolean>>
  setAssetSelectionRecords: Dispatch<SetStateAction<AssetSelectionRecords>>
}

export function useCanvasRepository({
  repoPath,
  executor,
  flow,
  updateZoomCompensation,
  selection,
  refresh,
  setRefresh,
  setError,
  setReady,
  setAssetSelectionRecords,
}: Props) {
  const initialization = useRef(0)
  const fitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
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
  const initialize = useCallback(async (): Promise<void> => {
    const request = ++initialization.current
    if (fitTimer.current) clearTimeout(fitTimer.current)
    setReady(false)
    const [result, viewport] = await Promise.all([
      executor.refresh(),
      ImageService.GetViewport(repoPath),
    ])
    if (request !== initialization.current || executor.isActive?.() === false)
      return
    if (viewport) {
      updateZoomCompensation(viewport.zoom)
      await flow.setViewport(viewport)
    }
    setReady(true)
    if (
      !viewport &&
      (result?.data.images ?? []).some(
        (image) => image.placed && !image.trashed
      )
    ) {
      fitTimer.current = setTimeout(() => {
        if (
          request === initialization.current &&
          executor.isActive?.() !== false
        ) {
          void flow.fitView({ padding: 0.2, maxZoom: 1 })
        }
      }, 100)
    }
  }, [executor, flow, repoPath, setReady, updateZoomCompensation])
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
    void Promise.all(
      ids.map((id) =>
        ImageService.GetImage(repoPath, id).catch((cause: unknown) => {
          if (isMissingImageError(cause)) return null
          throw cause
        })
      )
    )
      .then((images) => {
        if (cancelled) return
        setAssetSelectionRecords({
          key: assetSelectionKey,
          // Undo can remove a selected imported image. Treat that stale
          // selection as absent instead of surfacing a misleading error toast.
          records: images.filter((image): image is ImageInfo => image !== null),
        })
      })
      .catch(report)
    return () => {
      cancelled = true
    }
  }, [assetSelectionKey, repoPath, report, setAssetSelectionRecords])
  const run = useCallback(
    (action: () => Promise<unknown>) => {
      void executor
        .execute(async () => {
          await action()
          await reload()
        })
        .catch(report)
    },
    [executor, reload, report]
  )
  useEffect(() => {
    void initialize().catch(report)
    return () => {
      initialization.current++
      if (fitTimer.current) clearTimeout(fitTimer.current)
    }
  }, [initialize, report])
  return { report, reload, reloadForData, initialize, run, assetSelectionKey }
}

function isMissingImageError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /^image \d+ not found$/.test(message)
}
