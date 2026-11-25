import { describe, expect, it } from 'bun:test'
import type { GeometryUpdate } from '../../../bindings/loom/internal/service'
import { resizeRectangle } from './canvas-resize-geometry'

const before: GeometryUpdate = {
  imageId: 7,
  x: 20,
  y: 30,
  w: 150,
  h: 110,
}

describe('controlled canvas resize geometry', () => {
  it('preserves all eight handle directions', () => {
    expect(resizeRectangle(before, 'nw', -10, -10)).toEqual({
      imageId: 7,
      x: 10,
      y: 20,
      w: 160,
      h: 120,
    })
    expect(resizeRectangle(before, 'n', 10, -10)).toEqual({
      imageId: 7,
      x: 20,
      y: 20,
      w: 150,
      h: 120,
    })
    expect(resizeRectangle(before, 'ne', 10, -10)).toEqual({
      imageId: 7,
      x: 20,
      y: 20,
      w: 160,
      h: 120,
    })
    expect(resizeRectangle(before, 'e', 10, -10)).toEqual({
      imageId: 7,
      x: 20,
      y: 30,
      w: 160,
      h: 110,
    })
    expect(resizeRectangle(before, 'se', 10, 10)).toEqual({
      imageId: 7,
      x: 20,
      y: 30,
      w: 160,
      h: 120,
    })
    expect(resizeRectangle(before, 's', 10, 10)).toEqual({
      imageId: 7,
      x: 20,
      y: 30,
      w: 150,
      h: 120,
    })
    expect(resizeRectangle(before, 'sw', -10, 10)).toEqual({
      imageId: 7,
      x: 10,
      y: 30,
      w: 160,
      h: 120,
    })
    expect(resizeRectangle(before, 'w', -10, 10)).toEqual({
      imageId: 7,
      x: 10,
      y: 30,
      w: 160,
      h: 110,
    })
  })

  it('enforces the existing 100 by 80 minimum while preserving the opposite edge', () => {
    expect(resizeRectangle(before, 'nw', 100, 100)).toEqual({
      imageId: 7,
      x: 70,
      y: 60,
      w: 100,
      h: 80,
    })
  })
})
