import type { GeometryUpdate } from '../../../bindings/loom/internal/service'
import type { ResizeDirection } from './canvas-resize-geometry'

export interface ResizeGesture {
  kind: 'resize'
  token: number
  pointerId: number
  cancelled: boolean
  generation: number
  modeRevision: number
  lifetimeRevision: number
  revision: string
  expected: GeometryUpdate
  before: GeometryUpdate
  direction: ResizeDirection
  onPreview: (geometry: GeometryUpdate) => void
  onCancel: () => void
}

export interface DragGesture {
  kind: 'drag'
  cancelled: boolean
  generation: number
  revision: string
  expected: GeometryUpdate[]
  before: GeometryUpdate[]
  onCancel?: () => void
}
