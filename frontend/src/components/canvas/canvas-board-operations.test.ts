import { describe, expect, it } from 'bun:test'
import type { CanvasData } from '../../../bindings/loom/internal/service'
import { validateRelationshipTarget } from './canvas-board-operations'

const data = {
  images: [
    { id: 1, trashed: false, missing: false },
    { id: 2, trashed: false, missing: false },
    { id: 3, trashed: false, missing: false },
    { id: 4, trashed: false, missing: true },
  ],
  relationships: [
    { id: 10, sourceImageId: 1, derivedImageId: 2 },
    { id: 11, sourceImageId: 2, derivedImageId: 3 },
  ],
  groups: [],
} as CanvasData

describe('relationship target validation', () => {
  const validate = (source: number, target: number) =>
    validateRelationshipTarget(source, String(target), data, () => [])

  it('rejects duplicate and unavailable endpoints', () => {
    expect(validate(1, 2).valid).toBe(false)
    expect(validate(1, 4).valid).toBe(false)
    expect(validate(4, 1).valid).toBe(false)
    expect(validate(1, 999).valid).toBe(false)
  })

  it('rejects self-links and cycles while allowing valid links', () => {
    expect(validate(1, 1).valid).toBe(false)
    expect(validate(3, 1).valid).toBe(false)
    expect(validate(1, 3).valid).toBe(true)
  })
})
