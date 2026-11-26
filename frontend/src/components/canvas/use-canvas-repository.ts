import type { ReactFlowInstance } from '@xyflow/react'
import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect } from 'react'
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
    (action: () => Promise<unknown>, guard?: () => boolean) => {
      void executor
        .execute(async () => {
          if (executor.isActive?.() === false || guard?.() === false) return
          await action()
          if (executor.isActive?.() === false || guard?.() === false) return
          await reload()
        })
        .catch(report)
    },
    [executor, reload, report]
  )
  useEffect(() => {
    let cancelled = false
    let fitTimer: ReturnType<typeof setTimeout> | undefined
    void Promise.all([executor.refresh(), ImageService.GetViewport(repoPath)])
      .then(([result, viewport]) => {
        if (cancelled) return
        if (viewport) {
          updateZoomCompensation(viewport.zoom)
          void flow.setViewport(viewport)
        }
        setReady(true)
        if (
          !viewport &&
          (result?.data.images ?? []).some(
            (image) => image.placed && !image.trashed
          )
        )
          fitTimer = setTimeout(
            () => void flow.fitView({ padding: 0.2, maxZoom: 1 }),
            100
          )
      })
      .catch((error) => {
        if (!cancelled) report(error)
      })
    return () => {
      cancelled = true
      if (fitTimer) clearTimeout(fitTimer)
    }
  }, [executor, repoPath, flow, updateZoomCompensation, setReady, report])
  return { report, reload, reloadForData, run, assetSelectionKey }
}
