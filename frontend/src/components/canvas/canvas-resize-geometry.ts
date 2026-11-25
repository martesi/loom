import type { GeometryUpdate } from '../../../bindings/loom/internal/service'

export const resizeDirections = [
  'nw',
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
] as const

export type ResizeDirection = (typeof resizeDirections)[number]

export function resizeRectangle(
  before: GeometryUpdate,
  direction: ResizeDirection,
  dx: number,
  dy: number
): GeometryUpdate {
  const initialX = before.x ?? 0
  const initialY = before.y ?? 0
  const initialWidth = before.w ?? 150
  const initialHeight = before.h ?? 110
  let x = initialX
  let y = initialY
  let w = initialWidth
  let h = initialHeight
  if (direction.includes('w')) {
    const width = Math.max(100, initialWidth - dx)
    x = initialX + initialWidth - width
    w = width
  }
  if (direction.includes('e')) w = Math.max(100, initialWidth + dx)
  if (direction.includes('n')) {
    const height = Math.max(80, initialHeight - dy)
    y = initialY + initialHeight - height
    h = height
  }
  if (direction.includes('s')) h = Math.max(80, initialHeight + dy)
  return { imageId: before.imageId, x, y, w, h }
}
