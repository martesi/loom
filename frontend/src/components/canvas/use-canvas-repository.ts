import {
  getNodesBounds,
  getViewportForBounds,
  type ReactFlowInstance,
} from '@xyflow/react'
import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useState } from 'react'
import {
  type CanvasData,
  type ImageInfo,
  ImageService,
  SettingsService,
} from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import type { CanvasBoardOwner } from './canvas-board-owner'
import type { createCanvasCamera } from './canvas-camera'
import { loadCanvasViewport } from './canvas-viewport-store'

interface AssetSelectionRecords {
  key: string
  records: ImageInfo[]
}

interface Props {
  repoPath: string
  executor: CanvasBoardOwner
  flow: ReactFlowInstance
  camera: ReturnType<typeof createCanvasCamera>
  host: { current: HTMLDivElement | null }
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
  camera,
  host,
  updateZoomCompensation,
  selection,
  refresh,
  setRefresh,
  setError,
  setReady,
  setAssetSelectionRecords,
}: Props) {
  const [initialMode, setInitialMode] = useState<'view' | 'edit' | null>(null)
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
    let cancelled = false
    const cameraVersion = camera.version()
    let fitTimer: ReturnType<typeof setTimeout> | undefined
    setInitialMode(null)
    void Promise.all([
      executor.refresh(),
      loadCanvasViewport(repoPath),
      SettingsService.Get(repoPath, 'canvas_mode'),
    ])
      .then(([result, viewport, savedMode]) => {
        if (cancelled) return
        if (viewport && camera.version() === cameraVersion) {
          updateZoomCompensation(viewport.zoom)
          camera.restore(viewport)
        }
        setInitialMode(savedMode === 'edit' ? 'edit' : 'view')
        setReady(true)
        if (
          !viewport &&
          (result?.data.images ?? []).some(
            (image) => image.placed && !image.trashed
          )
        )
          fitTimer = setTimeout(() => {
            if (camera.version() !== cameraVersion) return
            const nodes = flow.getNodes()
            const element = host.current
            if (!nodes.length || !element) return
            const target = getViewportForBounds(
              getNodesBounds(nodes),
              element.clientWidth,
              element.clientHeight,
              0.05,
              1,
              0.2
            )
            void camera.move(async () => target)
          }, 100)
      })
      .catch((error) => {
        if (!cancelled) report(error)
      })
    return () => {
      cancelled = true
      if (fitTimer) clearTimeout(fitTimer)
    }
  }, [
    executor,
    repoPath,
    flow,
    camera,
    host,
    updateZoomCompensation,
    setReady,
    report,
  ])
  return { report, reload, reloadForData, run, assetSelectionKey, initialMode }
}
