import { expect, test } from 'bun:test'
import { applyCanvasNodeSelection } from './canvas-selection'
import { emptySelection } from './selection'

test('repro: fully enclosed image and set can be lost during controlled select reconciliation', () => {
  // Partial mode can report a positive intersection after controlled nodes
  // have already reported a stale deselection in the same marquee update.
  const staleSelection = {
    surface: 'canvas',
    ids: [12],
    edges: [],
    group: null,
  }
  expect(
    applyCanvasNodeSelection(
      staleSelection,
      [{ id: '12', selected: false }, { id: '12', selected: true }],
      false,
      []
    )
  ).toEqual({ surface: 'canvas', ids: [12], edges: [], group: null })
  expect(
    applyCanvasNodeSelection(
      emptySelection,
      [{ id: 'set-7', selected: true }],
      false,
      []
    )
  ).toEqual({ surface: 'canvas', ids: [], edges: [], group: 7 })
})

test('partial intersections on either side select; additive selection preserves anchor', () => {
  expect(
    applyCanvasNodeSelection(emptySelection, [{ id: '8', selected: true }], false, [])
  ).toEqual({ surface: 'canvas', ids: [8], edges: [], group: null })
  expect(
    applyCanvasNodeSelection(
      { surface: 'canvas', ids: [3], edges: [], group: null },
      [{ id: '8', selected: true }],
      true,
      [3]
    )
  ).toEqual({ surface: 'canvas', ids: [3, 8], edges: [], group: null })
})

test('additive marquee does not lose an already selected set on stale deselection', () => {
  expect(
    applyCanvasNodeSelection(
      { surface: 'canvas', ids: [3], edges: [], group: 7 },
      [{ id: 'set-7', selected: false }, { id: '8', selected: true }],
      true,
      [3]
    )
  ).toEqual({ surface: 'canvas', ids: [3, 8], edges: [], group: 7 })
})
