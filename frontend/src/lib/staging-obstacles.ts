import type { LayoutBox } from './layout'

export const GAP = 60

type Rect = { x: number; y: number; width: number; height: number }

export function clearObstacles(
  rect: Rect,
  obstacles: LayoutBox[],
  direction: 'up' | 'down' | 'left' | 'right'
): Rect {
  const result = { ...rect }
  const vertical = direction === 'up' || direction === 'down'
  const forward = direction === 'down' || direction === 'right'
  const axis = vertical ? 'y' : 'x'
  const size = vertical ? 'height' : 'width'
  const crossAxis = vertical ? 'x' : 'y'
  const crossSize = vertical ? 'width' : 'height'
  const relevant = obstacles.filter(
    (box) =>
      rect[crossAxis] < box[crossAxis] + box[crossSize] + GAP &&
      rect[crossAxis] + rect[crossSize] + GAP > box[crossAxis]
  )
  // Sweeping in movement order visits each forbidden interval only once.
  relevant.sort((a, b) =>
    forward
      ? a[axis] - b[axis]
      : b[axis] + b[size] + GAP - (a[axis] + a[size] + GAP)
  )
  for (const box of relevant) {
    if (
      result[axis] >= box[axis] + box[size] + GAP ||
      result[axis] + result[size] + GAP <= box[axis]
    )
      continue
    result[axis] = forward
      ? box[axis] + box[size] + GAP
      : precedingBoundary(box[axis], result[size])
    if (!Number.isFinite(result[axis]))
      throw new Error('staging position exceeds finite coordinates')
  }
  return result
}

function precedingBoundary(boundary: number, size: number): number {
  let position = boundary - size - GAP
  let adjustment = Number.EPSILON * Math.max(1, Math.abs(boundary), size)
  // Subtraction can round back inside the forbidden interval. Move outward
  // until the same arithmetic used by the collision test confirms clearance.
  while (position + size + GAP > boundary) {
    position -= adjustment
    adjustment *= 2
    if (!Number.isFinite(position))
      throw new Error('staging position exceeds finite coordinates')
  }
  return position
}
