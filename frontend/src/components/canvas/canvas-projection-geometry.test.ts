import { describe, expect, it } from 'bun:test'
import type { GeometryUpdate } from '../../../bindings/loom/internal/service'
import {
  createCanvasProjection,
  enterEdit,
  reconcileCanvasProjection,
} from './canvas-projection'
import {
  acceptDisplayGeometry,
  applyProjectionUndo,
  prepareDisplayGeometry,
} from './canvas-projection-geometry'

const rect = (
  imageId: number,
  x: number | null,
  y: number | null,
  w: number | null = 100,
  h: number | null = 60
): GeometryUpdate => ({ imageId, x, y, w, h })
const input = {
  nodes: [1, 2].map((id) => ({
    id: String(id),
    position: { x: 0, y: 0 },
    width: 100,
    height: 60,
    data: {},
  })),
  edges: [{ id: 'a', source: '1', target: '2' }],
  pairingOrders: new Map([['a', 1]]),
  geometry: [rect(1, null, null, null, null), rect(2, 10, 20)],
  viewport: { x: 0, y: 0, zoom: 1 },
  viewportSize: { width: 800, height: 600 },
}

describe('display geometry history', () => {
  it('keeps stored, displayed and after rectangles distinct across gestures and no-ops', () => {
    let state = enterEdit(createCanvasProjection(input))
    const before = [rect(1, 100, 200), rect(2, 300, 400)]
    const after = [rect(1, 110, 210), before[1]]
    const batch = prepareDisplayGeometry(state, before, after)
    expect(batch.expected).toEqual(input.geometry)
    expect(batch.before).toEqual(before)
    expect(batch.after).toEqual(after)
    expect(batch.changed).toBe(true)
    state = acceptDisplayGeometry(state, batch)
    const unchanged = prepareDisplayGeometry(
      state,
      [rect(1, 999, 999)],
      [rect(1, 999, 999)]
    )
    expect(unchanged.changed).toBe(false)
    state = acceptDisplayGeometry(state, unchanged)
    expect(state.expectedGeometry.get(1)).toEqual(after[0])
    expect(prepareDisplayGeometry(state, after, before).expected).toEqual(after)
    expect(() =>
      prepareDisplayGeometry(state, [rect(3, 0, 0)], [rect(3, 1, 1)])
    ).toThrow('missing expected')
  })

  it('applies all geometry results including unchanged rows and null pairs, but not semantic history', () => {
    let state = enterEdit(createCanvasProjection(input))
    const before = [rect(1, 100, 200), rect(2, 300, 400)]
    state = acceptDisplayGeometry(
      state,
      prepareDisplayGeometry(state, before, [rect(1, 110, 210), before[1]])
    )
    const untouched = applyProjectionUndo(
      state,
      { applied: true, kind: 'relationship' },
      () => {
        throw new Error('semantic undo resolved geometry')
      }
    )
    expect(untouched).toBe(state)
    let received: readonly GeometryUpdate[] = []
    const rows = [rect(1, null, null), rect(2, 300, 400, null, null)]
    state = applyProjectionUndo(
      state,
      { applied: true, kind: 'geometry', geometry: rows },
      (nodes, geometry) => {
        received = geometry
        return nodes.map((node) => ({
          ...node,
          position: { x: -Number(node.id), y: 12 },
        }))
      }
    )
    expect(received).toEqual(rows)
    expect([...state.expectedGeometry.values()]).toEqual(rows)
    expect(state.editNodes[1].position).toEqual({ x: -2, y: 12 })
    expect(
      applyProjectionUndo(state, { applied: false, geometry: before }, () => {
        throw new Error('failed undo')
      })
    ).toBe(state)
    state = applyProjectionUndo(
      state,
      { applied: true, geometry: before },
      (nodes) => [...nodes]
    )
    expect([...state.expectedGeometry.values()]).toEqual(before)
  })

  it('replaces the baseline on reload without moving Edit nodes', () => {
    let state = enterEdit(createCanvasProjection(input))
    const positions = state.editNodes.map((node) => node.position)
    const geometry = [rect(1, 7, 8), rect(2, null, null, null, null)]
    state = reconcileCanvasProjection(state, { ...input, geometry })
    expect(state.editNodes.map((node) => node.position)).toEqual(positions)
    expect(prepareDisplayGeometry(state, geometry, geometry).expected).toEqual(
      geometry
    )
  })

  it('retains geometry restored by history across a metadata refresh', () => {
    let state = enterEdit(createCanvasProjection(input))
    const restored = rect(1, 70, 80, 300, 240)
    state = applyProjectionUndo(
      state,
      { applied: true, kind: 'geometry', geometry: [restored] },
      (nodes) =>
        nodes.map((node) =>
          node.id === '1'
            ? {
                ...node,
                position: { x: 70, y: 80 },
                width: 300,
                height: 240,
                measured: { width: 300, height: 240 },
              }
            : node
        )
    )
    state = reconcileCanvasProjection(state, {
      ...input,
      nodes: input.nodes.map((node) => ({
        ...node,
        data: { label: 'updated' },
      })),
      geometry: [restored, input.geometry[1]],
    })
    expect(state.editNodes[0]).toMatchObject({
      position: { x: 70, y: 80 },
      width: 300,
      height: 240,
      measured: { width: 300, height: 240 },
      data: { label: 'updated' },
    })
  })
})
