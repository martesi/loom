import { describe, expect, it } from 'bun:test'
import {
  previewRequestUrl,
  previewTierForNode,
  renditionGenerationUrl,
} from './preview-tier'

describe('previewTierForNode', () => {
  it('uses the thumbnail below the smallest preview size', () => {
    expect(previewTierForNode(150, 110, 1200, 800, 1, 1)).toBeNull()
  })

  it('selects the smallest tier for object-cover dimensions', () => {
    expect(previewTierForNode(300, 200, 2400, 1200, 1, 1)).toBe(640)
    expect(previewTierForNode(500, 250, 2400, 1200, 2, 1)).toBe(1280)
    expect(previewTierForNode(700, 400, 2400, 1200, 2, 1)).toBe(2048)
    expect(previewTierForNode(900, 500, 1000, 500, 2, 1)).toBe(1280)
  })

  it('accounts for device pixel ratio and rejects missing dimensions', () => {
    expect(previewTierForNode(250, 200, 1600, 1200, 1, 2)).toBe(640)
    expect(previewTierForNode(250, 200, 0, 1200, 1, 1)).toBeNull()
    expect(previewTierForNode(250, 200, Number.NaN, 1200, 1, 1)).toBeNull()
  })

  it('appends a tier to the revisioned preview URL', () => {
    expect(previewRequestUrl('/loom-asset/preview/repo/1?v=abc123', 1280)).toBe(
      '/loom-asset/preview/repo/1?v=abc123&w=1280'
    )
  })

  it('adds a UI generation without replacing the preview revision', () => {
    expect(
      renditionGenerationUrl('/loom-asset/preview/repo/1?v=abc123&w=640', 2)
    ).toBe('/loom-asset/preview/repo/1?v=abc123&w=640&ui=2')
    expect(renditionGenerationUrl('/loom-asset/thumb/repo/1?v=abc123', 0)).toBe(
      '/loom-asset/thumb/repo/1?v=abc123'
    )
  })
})
