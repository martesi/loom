import type {
  CanvasData,
  ImageInfo,
} from '../../../bindings/loom/internal/service'
import type { CanvasInternalMode } from './canvas-mode-policy'

export type PreviewOrigin =
  | { surface: 'canvas' }
  | { surface: 'folder'; folder: string }

interface Props {
  data: CanvasData
  mode: CanvasInternalMode
  graphOrder: number[]
  repoPath: string
  previewOrigin: PreviewOrigin | null
  previewFolderOrder: number[] | null
  previewImageId: number | null
  setPreviewOrigin: (origin: PreviewOrigin | null) => void
  setPreviewFolderOrder: (order: number[] | null) => void
  setPreviewImageId: (id: number | null) => void
}

export function useCanvasPreview({
  data,
  mode,
  graphOrder,
  repoPath,
  previewOrigin,
  previewFolderOrder,
  previewImageId,
  setPreviewOrigin,
  setPreviewFolderOrder,
  setPreviewImageId,
}: Props) {
  const images = ((): ImageInfo[] => {
    const all = (data.images ?? []).filter((image) => !image.trashed)
    if (previewOrigin?.surface === 'folder') {
      const folder = previewOrigin.folder
      const folderOf = (image: ImageInfo) =>
        image.filePath
          .slice(repoPath.length + 1)
          .split('/')
          .slice(0, -1)
          .join('/')
      const inFolder = all.filter((image) => folderOf(image) === folder)
      if (previewFolderOrder && previewFolderOrder.length > 0) {
        const rank = new Map(
          previewFolderOrder.map((id, order) => [id, order] as const)
        )
        return [...inFolder].sort((left, right) => {
          const leftRank = rank.get(left.id)
          const rightRank = rank.get(right.id)
          if (leftRank !== undefined && rightRank !== undefined)
            return leftRank - rightRank
          // Items added after the folder list was captured follow known items.
          if (leftRank !== undefined) return -1
          if (rightRank !== undefined) return 1
          return left.fileName.localeCompare(right.fileName)
        })
      }
      return [...inFolder].sort((left, right) =>
        left.fileName.localeCompare(right.fileName)
      )
    }
    if (previewImageId === null) return all
    if (!all.some((image) => image.id === previewImageId)) return all
    const neighbors = new Map<number, number[]>()
    const link = (source: number, target: number) => {
      const list = neighbors.get(source)
      if (list) list.push(target)
      else neighbors.set(source, [target])
    }
    for (const relationship of data.relationships ?? []) {
      link(relationship.sourceImageId, relationship.derivedImageId)
      link(relationship.derivedImageId, relationship.sourceImageId)
    }
    const seen = new Set<number>([previewImageId])
    const queue = [previewImageId]
    while (queue.length > 0) {
      const id = queue.pop() as number
      for (const next of neighbors.get(id) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    const component = all.filter((image) => seen.has(image.id))
    if (mode === 'legacy') return component
    const rank = new Map(graphOrder.map((id, index) => [id, index]))
    return component.sort(
      (a, b) =>
        (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.id - b.id
    )
  })()
  const index = images.findIndex((image) => image.id === previewImageId)
  const relatedImages = (id: number, direction: 'sources' | 'children') =>
    (data.relationships ?? [])
      .flatMap((relationship) => {
        const matches =
          direction === 'sources'
            ? relationship.derivedImageId === id
            : relationship.sourceImageId === id
        if (!matches) return []
        const targetId =
          direction === 'sources'
            ? relationship.sourceImageId
            : relationship.derivedImageId
        const image = (mode === 'legacy' ? images : (data.images ?? [])).find(
          (candidate) => candidate.id === targetId && !candidate.trashed
        )
        return image
          ? [
              {
                id: image.id,
                fileName: image.fileName,
                thumbUrl: image.thumbUrl,
              },
            ]
          : []
      })
      .sort((a, b) => {
        if (mode === 'legacy') return 0
        const left = graphOrder.indexOf(a.id)
        const right = graphOrder.indexOf(b.id)
        return (
          (left < 0 ? Infinity : left) - (right < 0 ? Infinity : right) ||
          a.id - b.id
        )
      })

  function jumpTo(imageId: number) {
    if (images.some((image) => image.id === imageId)) {
      setPreviewImageId(imageId)
      return
    }
    // A related target outside a folder carousel starts a Canvas carousel.
    setPreviewOrigin({ surface: 'canvas' })
    setPreviewFolderOrder(null)
    setPreviewImageId(imageId)
  }

  function close() {
    setPreviewImageId(null)
    setPreviewOrigin(null)
    setPreviewFolderOrder(null)
  }

  return { images, index, relatedImages, jumpTo, close }
}
