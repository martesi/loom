import type { Edge, Node } from '@xyflow/react'
import type {
  CanvasData,
  ImageInfo,
} from '../../../bindings/loom/internal/service'
import { renditionGenerationUrl } from '../../lib/preview-tier'

/** Map LoadCanvas DTOs without treating saved placement as graph membership. */
export function canvasProjectionGraph(
  data: CanvasData,
  renditionGeneration: number,
  onResizeEnd: (id: number, x: number, y: number, w: number, h: number) => void
) {
  const images = (data.images ?? []).filter((image) => !image.trashed)
  const ids = new Set(images.map((image) => image.id))
  const relationships = (data.relationships ?? []).filter(
    (edge) => ids.has(edge.sourceImageId) && ids.has(edge.derivedImageId)
  )
  const nodes: Node[] = images.map((image) =>
    imageNode(image, renditionGeneration, onResizeEnd)
  )
  const edges: Edge[] = relationships.map((edge) => ({
    id: String(edge.id),
    source: String(edge.sourceImageId),
    target: String(edge.derivedImageId),
    reconnectable: false,
  }))
  return {
    nodes,
    edges,
    pairingOrders: new Map(
      relationships.map((edge) => [String(edge.id), edge.pairingOrder])
    ),
  }
}

function imageNode(
  image: ImageInfo,
  generation: number,
  onResizeEnd: (id: number, x: number, y: number, w: number, h: number) => void
): Node {
  return {
    id: String(image.id),
    type: 'image',
    position: { x: image.canvasX, y: image.canvasY },
    width: image.canvasW || 150,
    height: image.canvasH || 110,
    data: {
      fileName: image.fileName,
      thumbUrl: renditionGenerationUrl(image.thumbUrl, generation),
      previewUrl: image.previewUrl
        ? renditionGenerationUrl(image.previewUrl, generation)
        : undefined,
      missing: image.missing,
      showFileName: true,
      width: image.width,
      height: image.height,
      onResizeEnd: (x: number, y: number, w: number, h: number) =>
        onResizeEnd(image.id, x, y, w, h),
    },
  }
}
