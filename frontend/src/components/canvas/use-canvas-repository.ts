import type { ReactFlowInstance } from '@xyflow/react'
import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect } from 'react'
import {
  type CanvasData,
  type ImageInfo,
  ImageService,
} from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'

interface AssetSelectionRecords {
  key: string
  records: ImageInfo[]
}

interface Props {
  repoPath: string
  flow: ReactFlowInstance
  updateZoomCompensation: (zoom: number) => void
  selection: Selection
  refresh: number
  setData: Dispatch<SetStateAction<CanvasData>>
  setRefresh: Dispatch<SetStateAction<number>>
  setError: Dispatch<SetStateAction<string>>
  setReady: Dispatch<SetStateAction<boolean>>
  setAssetSelectionRecords: Dispatch<SetStateAction<AssetSelectionRecords>>
}

export function useCanvasRepository({
  repoPath,
  flow,
  updateZoomCompensation,
  selection,
  refresh,
  setData,
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
    const result = await ImageService.LoadCanvas(repoPath)
    if (result) setData(result)
    setRefresh((current) => current + 1)
  }, [repoPath, setData, setRefresh])
  const reloadForData = useCallback(async (): Promise<CanvasData | null> => {
    const result = await ImageService.LoadCanvas(repoPath)
    if (result) setData(result)
    setRefresh((current) => current + 1)
    return result
  }, [repoPath, setData, setRefresh])
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
    (action: () => Promise<unknown>) => {
      void action()
        .then(() => reload())
        .catch(report)
    },
    [reload, report]
  )
  useEffect(() => {
    void Promise.all([
      ImageService.LoadCanvas(repoPath),
      ImageService.GetViewport(repoPath),
    ])
      .then(([data, viewport]) => {
        if (data) setData(data)
        setRefresh((current) => current + 1)
        if (viewport) {
          updateZoomCompensation(viewport.zoom)
          void flow.setViewport(viewport)
        }
        setReady(true)
        if (
          !viewport &&
          (data?.images ?? []).some((image) => image.placed && !image.trashed)
        )
          setTimeout(() => void flow.fitView({ padding: 0.2, maxZoom: 1 }), 100)
      })
      .catch(report)
  }, [
    repoPath,
    flow,
    updateZoomCompensation,
    setData,
    setRefresh,
    setReady,
    report,
  ])
  return { report, reload, reloadForData, run, assetSelectionKey }
}
