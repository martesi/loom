import type { CanvasData } from '../../../bindings/loom/internal/service'

export const images = [1, 2, 3].map((id) => ({
  id,
  fileName: `${id}.png`,
  filePath: '',
  thumbUrl: '',
  previewUrl: '',
  fullUrl: '',
  width: 640,
  height: 480,
  archived: false,
  trashed: false,
  missing: false,
  placed: true,
  canvasX: id * 10,
  canvasY: 20,
  canvasW: 150,
  canvasH: 110,
  promptText: '',
  groupId: 0,
  createdAt: '',
}))
export const data: CanvasData = { images, relationships: [], groups: [] }
export const empty: CanvasData = { images: [], relationships: [], groups: [] }
export const relationships = [
  {
    id: 7,
    sourceImageId: 1,
    derivedImageId: 2,
    pairingOrder: 1,
    createdAt: null,
  },
]
