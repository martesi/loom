import { describe, expect, test } from 'bun:test'
import { layoutChronologicalGraph } from './chronological-layout'

const node = (id, width = 100, height = 60) => ({ id, width, height })
const edge = (id, source, target, pairingOrder) => ({
  id,
  source,
  target,
  pairingOrder,
})
const layout = (nodes, edges, options = {}) =>
  layoutChronologicalGraph({ nodes, edges, ...options })
const box = (projection, id) =>
  [
    ...projection.components.flatMap((component) => component.boxes),
    ...projection.staged,
  ].find((item) => item.id === id)
const overlaps = (a, b) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height
const expectNoOverlaps = (boxes) => {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      expect(overlaps(boxes[i], boxes[j])).toBe(false)
    }
  }
}

describe('chronological graph layout', () => {
  test('lays out a diamond left to right without collisions, invariant under input permutations', () => {
    const nodes = [node('a', 150, 90), node('b'), node('c', 80, 120), node('d')]
    const edges = [
      edge('1', 'a', 'b', 1),
      edge('2', 'a', 'c', 2),
      edge('3', 'b', 'd', 3),
      edge('4', 'c', 'd', 4),
    ]
    const result = layout(nodes, edges)
    expect(result).toEqual(layout([...nodes].reverse(), [...edges].reverse()))
    for (const link of edges) {
      expect(
        box(result, link.source).x + box(result, link.source).width
      ).toBeLessThanOrEqual(box(result, link.target).x)
    }
    expectNoOverlaps(result.components[0].boxes)
  })

  test('sorts weak components by earliest pairing and edge id, not input order or node id', () => {
    const nodes = 'abcdef'.split('').map((id) => node(id))
    const result = layout(nodes, [
      edge('z', 'a', 'b', 8),
      edge('b', 'c', 'd', 2),
      edge('a', 'e', 'f', 2),
    ])
    expect(result.components.map((component) => component.edgeIds)).toEqual([
      ['a'],
      ['b'],
      ['z'],
    ])
    expect(
      result.components.map((component) => component.pairingOrder)
    ).toEqual([2, 2, 8])
    expectNoOverlaps(result.components.flatMap((component) => component.boxes))
  })

  test('growth preserves other component shapes and shifts later components only when needed', () => {
    const nodes = 'abcdefg'.split('').map((id) => node(id))
    const initialEdges = [
      edge('1', 'a', 'b', 1),
      edge('2', 'c', 'd', 2),
      edge('3', 'e', 'f', 3),
    ]
    const initial = layout(nodes, initialEdges)
    const grown = layout(nodes, [...initialEdges, edge('4', 'a', 'g', 4)], {
      previous: initial,
    })
    expect(
      grown.components[1].boxes.map(({ id, x, y }) => [
        id,
        x,
        y - box(grown, 'c').y,
      ])
    ).toEqual(
      initial.components[1].boxes.map(({ id, x, y }) => [
        id,
        x,
        y - box(initial, 'c').y,
      ])
    )
    expect(box(grown, 'c').y).toBeGreaterThanOrEqual(box(initial, 'c').y)
    expect(box(grown, 'e').y - box(initial, 'e').y).toBe(
      box(grown, 'c').y - box(initial, 'c').y
    )
    expectNoOverlaps(grown.components.flatMap((component) => component.boxes))
    expect(layout(nodes, initialEdges, { previous: initial })).toEqual(initial)
  })

  test('merge and split use surviving earliest edges, with stable unaffected components', () => {
    const nodes = 'abcdefgh'.split('').map((id) => node(id))
    const edges = [
      edge('a', 'a', 'b', 2),
      edge('b', 'c', 'd', 5),
      edge('c', 'e', 'f', 9),
    ]
    const initial = layout(nodes, edges)
    const merged = layout(nodes, [...edges, edge('m', 'b', 'c', 10)], {
      previous: initial,
    })
    expect(
      merged.components.map((component) => component.pairingOrder)
    ).toEqual([2, 9])
    expect(merged.components[0].edgeIds).toEqual(['a', 'b', 'm'])
    const split = layout(nodes, edges.slice(1), { previous: merged })
    expect(split.components.map((component) => component.pairingOrder)).toEqual(
      [5, 9]
    )
    expect(split.components[1].boxes.map(({ id, x }) => [id, x])).toEqual(
      initial.components[2].boxes.map(({ id, x }) => [id, x])
    )
    expectNoOverlaps(split.components.flatMap((component) => component.boxes))
  })

  test('reversal preserves pairing order while reversing generation direction', () => {
    const nodes = [node('a'), node('b')]
    const before = layout(nodes, [edge('same', 'a', 'b', 7)])
    const after = layout(nodes, [edge('same', 'b', 'a', 7)], {
      previous: before,
    })
    expect(after.components[0].pairingOrder).toBe(7)
    expect(box(after, 'b').x).toBeLessThan(box(after, 'a').x)
  })

  test('box iteration is topological, breaking available-node ties by pairing then ID', () => {
    const nodes = ['z', 'a', 'c', 'b', 'd'].map((id) => node(id))
    const edges = [
      edge('1', 'z', 'a', 1),
      edge('2', 'z', 'b', 2),
      edge('3', 'z', 'c', 3),
      edge('4', 'a', 'd', 4),
      edge('5', 'b', 'd', 5),
    ]
    const result = layout(nodes, edges)
    expect(result.components[0].boxes.map((item) => item.id)).toEqual([
      'z',
      'a',
      'b',
      'c',
      'd',
    ])
    const positions = new Map(
      result.components[0].boxes.map((item, i) => [item.id, i])
    )
    for (const link of edges)
      expect(positions.get(link.source)).toBeLessThan(
        positions.get(link.target)
      )
  })

  test('cached projections survive JSON and permutations without moving unaffected components', () => {
    const nodes = 'abcdefg'.split('').map((id) => node(id))
    const edges = [
      edge('1', 'a', 'b', 1),
      edge('2', 'c', 'd', 2),
      edge('3', 'e', 'f', 3),
    ]
    const before = layout(nodes, edges)
    const previous = JSON.parse(JSON.stringify(before))
    const after = layout([...nodes].reverse(), [...edges].reverse(), {
      previous,
    })
    expect(after).toEqual(before)
    const extended = [...edges, edge('4', 'a', 'g', 4)]
    expect(layout(nodes, extended, { previous })).toEqual(
      layout([...nodes].reverse(), [...extended].reverse(), { previous })
    )
    expect(
      layout(nodes, [...edges, edge('4', 'a', 'g', 4)], { previous })
        .components[0].signature
    ).not.toBe(before.components[0].signature)
  })

  test('extra horizontal growth leaves subsequent components exactly in place', () => {
    const nodes = 'abcde'.split('').map((id) => node(id))
    const edges = [edge('1', 'a', 'b', 1), edge('2', 'c', 'd', 2)]
    const before = layout(nodes, edges)
    const after = layout(nodes, [...edges, edge('3', 'b', 'e', 3)], {
      previous: before,
    })
    expect(after.components[1].boxes).toEqual(before.components[1].boxes)
  })

  test('changing a later component leaves every earlier component exactly in place', () => {
    const nodes = 'abcdef'.split('').map((id) => node(id))
    const edges = [edge('1', 'a', 'b', 1), edge('2', 'c', 'd', 2)]
    const before = layout(nodes, edges)
    const after = layout(
      nodes,
      [...edges, edge('3', 'c', 'e', 3), edge('4', 'c', 'f', 4)],
      { previous: before }
    )
    expect(after.components[0]).toEqual(before.components[0])
    expectNoOverlaps(after.components.flatMap((component) => component.boxes))
  })

  test('all permutations of diamond nodes and links produce the same projection', () => {
    const permutations = (items) =>
      items.length === 0
        ? [[]]
        : items.flatMap((item, index) =>
            permutations(items.filter((_, i) => i !== index)).map((rest) => [
              item,
              ...rest,
            ])
          )
    const nodes = 'abcd'.split('').map((id) => node(id))
    const edges = [
      edge('x', 'a', 'b', 1),
      edge('w', 'a', 'c', 1),
      edge('z', 'b', 'd', 2),
      edge('y', 'c', 'd', 2),
    ]
    const expected = layout(nodes, edges)
    for (const nodeOrder of permutations(nodes)) {
      for (const edgeOrder of permutations(edges))
        expect(layout(nodeOrder, edgeOrder)).toEqual(expected)
    }
  })

  test('preserves spacing after shrink and consumes only the gap needed on later growth', () => {
    const nodes = 'abcdefg'.split('').map((id) => node(id))
    const edges = [
      edge('1', 'a', 'b', 1),
      edge('2', 'a', 'c', 2),
      edge('3', 'd', 'e', 3),
    ]
    const large = layout(nodes, edges)
    const small = layout(nodes, edges.slice(1), { previous: large })
    expect(small.components[1].boxes).toEqual(large.components[1].boxes)
    const grown = layout(
      nodes,
      [...edges, edge('4', 'a', 'f', 4), edge('5', 'a', 'g', 5)],
      { previous: small }
    )
    const firstBottom = Math.max(
      ...grown.components[0].boxes.map((item) => item.y + item.height)
    )
    const secondTop = Math.min(
      ...grown.components[1].boxes.map((item) => item.y)
    )
    expect(secondTop).toBe(Math.max(box(small, 'd').y, firstBottom + 60))
  })

  test('stages unpaired images compactly near the center without overlapping actual graph bounds', () => {
    const nodes = [
      node('a', 250, 300),
      node('b', 200, 50),
      node('c', 80, 220),
      node('d', 300, 60),
      node('e', 30, 30),
    ]
    const edges = [edge('1', 'a', 'b', 1)]
    const view = layout(nodes, edges)
    expect(view.staged).toEqual([])
    const edit = layout(nodes, edges, { stagingCenter: { x: 100, y: 100 } })
    expect(edit.staged.map((item) => item.id)).toEqual(['c', 'd', 'e'])
    expectNoOverlaps([...edit.components[0].boxes, ...edit.staged])
    expect(edit).toEqual(
      layout([...nodes].reverse(), edges, { stagingCenter: { x: 100, y: 100 } })
    )
  })

  test('empty graph stages orphans around viewport center and last-edge removal makes orphans', () => {
    const nodes = [node('a'), node('b')]
    const prior = layout(nodes, [edge('1', 'a', 'b', 1)])
    const result = layout(nodes, [], {
      previous: prior,
      stagingCenter: { x: 1000, y: -500 },
    })
    expect(result.components).toEqual([])
    expect(result.staged).toHaveLength(2)
    expectNoOverlaps(result.staged)
    const minX = Math.min(...result.staged.map((item) => item.x))
    const maxX = Math.max(...result.staged.map((item) => item.x + item.width))
    expect((minX + maxX) / 2).toBe(1000)
  })

  test('rejects invalid graphs instead of silently dropping data', () => {
    expect(() => layout([node('a')], [edge('1', 'a', 'missing', 1)])).toThrow()
    expect(() => layout([node('a'), node('a')], [])).toThrow()
    expect(() =>
      layout(
        [node('a'), node('b')],
        [edge('1', 'a', 'b', 1), edge('2', 'b', 'a', 2)]
      )
    ).toThrow()
    expect(() => layout([node('a')], [edge('1', 'a', 'a', 1)])).toThrow()
    expect(() => layout([node('a', 0, 1)], [])).toThrow()
    expect(() =>
      layout([node('a'), node('b')], [edge('1', 'a', 'b', NaN)])
    ).toThrow()
    expect(() =>
      layout(
        [node('a'), node('b')],
        [edge('1', 'a', 'b', 1), edge('1', 'a', 'b', 2)]
      )
    ).toThrow()
  })
})
