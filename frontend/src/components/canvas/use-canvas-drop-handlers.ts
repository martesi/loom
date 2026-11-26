import type { ReactFlowInstance, XYPosition } from '@xyflow/react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { CanvasData } from '../../../bindings/loom/internal/service'
import { ImageService } from '../../../bindings/loom/internal/service'
import { parseAssetDragPayload } from '../../lib/asset-drag-payload'
import type { readMedia } from '../../lib/clipboard'
import { filesToMedia } from '../../lib/clipboard'
import type { Selection } from '../../lib/selection'
import type { CanvasBoardOwner } from './canvas-board-owner'

interface Props {
  repoPath: string
  owner: CanvasBoardOwner
  flow: ReactFlowInstance
  paste: (
    media?: Awaited<ReturnType<typeof readMedia>>,
    surface?: Selection['surface'],
    dropPosition?: XYPosition
  ) => Promise<void>
  reloadForData: () => Promise<CanvasData | null>
  report: (error: unknown) => void
  assetsPinned: boolean
  closeAssets: (restoreFocus?: boolean) => void
  host: MutableRefObject<HTMLDivElement | null>
  setSelection: Dispatch<SetStateAction<Selection>>
}

export function useCanvasDropHandlers({
  repoPath,
  owner,
  flow,
  paste,
  reloadForData,
  report,
  assetsPinned,
  closeAssets,
  host,
  setSelection,
}: Props) {
  function onDragOver(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault()
    const isAssetDrag = Array.from(event.dataTransfer.types).includes(
      'application/x-loom-assets'
    )
    event.dataTransfer.dropEffect =
      isAssetDrag && !owner.allows('canvas-drop') ? 'none' : 'copy'
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault()
    const raw = event.dataTransfer.getData('application/x-loom-assets')
    if (!raw) {
      const dropPosition = flow.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })
      void filesToMedia(Array.from(event.dataTransfer.files))
        .then((media) => paste(media, 'canvas', dropPosition))
        .catch(report)
      return
    }
    if (!owner.allows('canvas-drop')) return
    const payload = parseAssetDragPayload(raw)
    if (!payload) {
      report(new Error('Invalid asset drag'))
      return
    }
    if (payload.repoPath !== repoPath) {
      report(new Error('This asset drag belongs to another repository'))
      return
    }
    const ids = [...new Set(payload.ids)]
    const point = flow.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    })
    void placeAssetsAtDrop(ids, point).catch(report)
  }

  async function placeAssetsAtDrop(ids: number[], point: XYPosition) {
    const images = await Promise.all(
      ids.map((id) => ImageService.GetImage(repoPath, id))
    )
    if (images.some((image) => !image || image.missing || image.trashed))
      throw new Error(
        'Missing or trashed assets cannot be placed. Refine the selection and try again.'
      )
    const placed = await owner.execute(async () => {
      if (!owner.allows('canvas-drop')) return false
      await ImageService.PlaceImages(repoPath, ids, point.x, point.y, 0)
      await reloadForData()
      return true
    })
    if (!placed) return
    if (!assetsPinned) {
      closeAssets(false)
      requestAnimationFrame(() => host.current?.focus())
    }
    setSelection({ surface: 'canvas', ids, edges: [], group: null })
  }

  return { onDragOver, onDrop }
}
