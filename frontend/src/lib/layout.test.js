import { describe, expect, test } from 'bun:test'
import { computeSubgraphLayout } from './layout'

const node = (id) => ({ id, width: 150, height: 110 })

describe('computeSubgraphLayout', () => {
  test('lays derivation generations left to right and keeps orphans separate', () => {
    const positions = computeSubgraphLayout(
      ['source', 'left', 'right', 'leaf', 'orphan'].map(node),
      [
        { source: 'source', target: 'left' },
        { source: 'source', target: 'right' },
        { source: 'left', target: 'leaf' },
      ]
    )

    const source = positions.get('source')
    const left = positions.get('left')
    const right = positions.get('right')
    const leaf = positions.get('leaf')
    const orphan = positions.get('orphan')
    expect(source).toBeDefined()
    expect(left).toBeDefined()
    expect(right).toBeDefined()
    expect(leaf).toBeDefined()
    expect(orphan).toBeDefined()
    if (!source || !left || !right || !leaf || !orphan) return

    expect(source.x).toBeLessThan(left.x)
    expect(source.x).toBeLessThan(right.x)
    expect(left.x).toBeLessThan(leaf.x)
    expect(left.x).toBe(right.x)
    expect(orphan.y).toBeGreaterThan(
      Math.max(source.y, left.y, right.y, leaf.y) + 110
    )
  })
})
