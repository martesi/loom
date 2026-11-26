import { describe, expect, it } from 'bun:test'
import { applyNodeChanges, type Edge, type Node } from '@xyflow/react'
import {
  arrangeEditProjection,
  arrangeEditSelection,
  createCanvasProjection,
  enterEdit,
  enterView,
  reconcileCanvasProjection,
  setEditNodes,
  setProjectionViewport,
  setViewAnchor,
} from './canvas-projection'

const makeNode = (id: string): Node => ({
  id,
  position: { x: 99, y: 99 },
  width: 100,
  height: 60,
  data: { label: id },
})
const link = (id: string, source: string, target: string): Edge => ({
  id,
  source,
  target,
})
const viewport = { x: 0, y: 0, zoom: 1 }
const input = (nodes: Node[], edges: Edge[]) => ({
  nodes,
  edges,
  pairingOrders: new Map(edges.map((edge, i) => [edge.id, i + 1])),
  geometry: [],
  viewport,
  viewportSize: { width: 800, height: 600 },
})
const at = (nodes: Node[], id: string) =>
  nodes.find((node) => node.id === id)?.position

describe('canvas projection', () => {
  it('arranges a selected subgraph around displayed unselected obstacles only', () => {
    const nodes = ['1', '2', '3', '4'].map(makeNode)
    let state = enterEdit(
      createCanvasProjection(
        input(nodes, [link('a', '1', '2'), link('b', '2', '3')])
      )
    )
    state = setEditNodes(
      state,
      state.editNodes.map((node) =>
        node.id === '1'
          ? { ...node, position: { x: 100, y: 100 }, width: 310, height: 190 }
          : node.id === '2'
            ? { ...node, position: { x: 140, y: 130 }, width: 170, height: 120 }
            : node.id === '3'
              ? { ...node, position: { x: 180, y: 160 } }
              : {
                  ...node,
                  position: { x: 600, y: 240 },
                  width: 220,
                  height: 160,
                }
      )
    )
    const before = new Map(
      state.editNodes.map((node) => [node.id, node.position])
    )
    const arranged = arrangeEditSelection(state, ['1', '2', '3'])
    expect(at(arranged.editNodes, '4')).toEqual(before.get('4'))
    expect(arranged.editNodes.find((node) => node.id === '1')?.width).toBe(310)
    expect(arranged.editNodes.find((node) => node.id === '1')?.height).toBe(190)
    for (const id of ['1', '2', '3'])
      expect(at(arranged.editNodes, id)).not.toEqual(before.get(id))
    const selectedBoxes = arranged.editNodes
      .filter((node) => node.id !== '4')
      .map((node) => ({
        x: node.position.x,
        y: node.position.y,
        width: node.measured?.width ?? node.width ?? 150,
        height: node.measured?.height ?? node.height ?? 110,
      }))
    for (const box of selectedBoxes)
      expect(
        box.x + box.width <= 600 ||
          box.x >= 820 ||
          box.y + box.height <= 240 ||
          box.y >= 400
      ).toBe(true)
    expect(
      arrangeEditSelection(arranged, ['1', '2', '3']).editNodes.map(
        (node) => node.position
      )
    ).toEqual(arranged.editNodes.map((node) => node.position))
    expect(() => arrangeEditSelection(enterView(state), ['1', '2'])).toThrow()
  })

  it('freshly arranges the whole Edit graph and stages orphans without overlap', () => {
    const nodes = ['1', '2', '3', '4', '5'].map(makeNode)
    const edges = [link('a', '1', '2'), link('b', '3', '4')]
    let state = enterEdit(createCanvasProjection(input(nodes, edges)))
    state = setEditNodes(
      state,
      state.editNodes.map((node) => ({
        ...node,
        position: { x: 900, y: 800 },
        width: node.id === '1' ? 250 : node.width,
      }))
    )
    const arranged = arrangeEditProjection(state)
    expect(arranged.editNodes).toHaveLength(5)
    expect(at(arranged.editNodes, '1')).not.toEqual({ x: 900, y: 800 })
    expect(arranged.editNodes[0].width).toBe(250)
    expect(at(arranged.editNodes, '1')?.y).toBeLessThan(
      at(arranged.editNodes, '3')?.y ?? 0
    )
    for (let i = 0; i < arranged.editNodes.length; i++) {
      for (let j = i + 1; j < arranged.editNodes.length; j++) {
        const a = arranged.editNodes[i]
        const b = arranged.editNodes[j]
        expect(
          a.position.x + (a.width ?? 150) <= b.position.x ||
            b.position.x + (b.width ?? 150) <= a.position.x ||
            a.position.y + (a.height ?? 110) <= b.position.y ||
            b.position.y + (b.height ?? 110) <= a.position.y
        ).toBe(true)
      }
    }
    expect(
      arrangeEditProjection(arranged).editNodes.map((node) => node.position)
    ).toEqual(arranged.editNodes.map((node) => node.position))
    expect(() => arrangeEditProjection(enterView(state))).toThrow()
  })

  it('arranges using current relationships and pairing order, not prior View positions', () => {
    const nodes = ['1', '2', '3', '4'].map(makeNode)
    const oldEdges = [link('a', '1', '2'), link('b', '3', '4')]
    let state = enterEdit(createCanvasProjection(input(nodes, oldEdges)))
    const newEdges = [link('a', '2', '1'), link('b', '3', '4')]
    state = reconcileCanvasProjection(state, {
      ...input(nodes, newEdges),
      pairingOrders: new Map([
        ['a', 2],
        ['b', 1],
      ]),
    })
    const arranged = arrangeEditProjection(state)
    const first = at(arranged.editNodes, '3')
    const source = at(arranged.editNodes, '2')
    const derivative = at(arranged.editNodes, '1')
    expect(first?.y).toBeLessThan(source?.y ?? 0)
    expect(source?.x).toBeLessThan(derivative?.x ?? 0)
    expect(arranged.viewNodes).toBe(state.viewNodes)
    expect(arranged.expectedGeometry).toBe(state.expectedGeometry)
  })

  it('shows paired nodes in View and retains their positions in Edit', () => {
    const nodes = ['1', '2', '3'].map((id) => ({
      id,
      position: { x: 99, y: 99 },
      width: 100,
      height: 60,
      data: {},
    }))
    const state = createCanvasProjection({
      nodes,
      edges: [{ id: '1', source: '1', target: '2' }],
      pairingOrders: new Map([['1', 1]]),
      geometry: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 800, height: 600 },
    })
    expect(state.viewNodes.map((node) => node.id)).toEqual(['1', '2'])
    const edit = enterEdit(state)
    expect(edit.editNodes).toHaveLength(3)
    expect(edit.editNodes[0].position).toEqual(state.viewNodes[0].position)
  })

  it('uses prior cached projection and keeps view and edit viewport and anchor separate', () => {
    const nodes = ['1', '2', '3', '4', '5'].map(makeNode)
    const edges = [link('a', '1', '2'), link('b', '3', '4')]
    let state = createCanvasProjection(input(nodes, edges))
    const previous = state.projection
    const reloaded = createCanvasProjection({
      ...input(nodes, edges),
      previous,
    })
    expect(reloaded.projection).toEqual(previous)
    state = setProjectionViewport(state, { x: -200, y: -100, zoom: 2 })
    state = setViewAnchor(state, { x: 42, y: 51 })
    state = enterEdit(state)
    expect(state.editViewport).toEqual(state.viewViewport)
    state = setProjectionViewport(state, { x: 12, y: 34, zoom: 0.5 })
    state = enterView(state)
    expect(state.viewViewport).toEqual({ x: -200, y: -100, zoom: 2 })
    expect(state.viewAnchor).toEqual({ x: 42, y: 51 })
    state = enterEdit(state)
    expect(state.editViewport).toEqual({ x: 12, y: 34, zoom: 0.5 })
    expect(at(state.editNodes, '1')).toEqual(at(state.viewNodes, '1'))
    expect(state.projection).toEqual(previous)
  })

  it('stages orphans at the transformed viewport center away from paired nodes', () => {
    const nodes = ['1', '2', '3'].map(makeNode)
    const state = enterEdit(
      createCanvasProjection({
        ...input(nodes, [link('a', '1', '2')]),
        viewport: { x: -1800, y: -800, zoom: 2 },
      })
    )
    expect(at(state.editNodes, '3')).toEqual({ x: 1050, y: 520 })
    expect(at(state.editNodes, '1')).toEqual(at(state.viewNodes, '1'))
  })

  it('reconciles metadata, new and removed nodes, and links without moving existing Edit nodes', () => {
    const nodes = ['1', '2', '3'].map(makeNode)
    const edges = [link('a', '1', '2')]
    let state = enterEdit(createCanvasProjection(input(nodes, edges)))
    state = setEditNodes(
      state,
      state.editNodes.map((node) =>
        node.id === '1' ? { ...node, position: { x: 800, y: 900 } } : node
      )
    )
    const old = new Map(state.editNodes.map((node) => [node.id, node.position]))
    const nextNodes = [
      makeNode('1'),
      { ...makeNode('2'), data: { label: 'updated' } },
      makeNode('4'),
    ]
    const nextEdges = [link('a', '2', '1'), link('b', '2', '4')]
    state = reconcileCanvasProjection(state, input(nextNodes, nextEdges))
    expect(at(state.editNodes, '1')).toEqual(old.get('1'))
    expect(at(state.editNodes, '2')).toEqual(old.get('2'))
    expect(state.editNodes.find((node) => node.id === '2')?.data.label).toBe(
      'updated'
    )
    expect(state.editNodes.map((node) => node.id)).toEqual(['1', '2', '4'])
    expect(state.edges).toEqual(nextEdges)
    expect(state.viewNodes).toHaveLength(3)
  })

  it('handles the first and last link without retaining orphaned View nodes', () => {
    const nodes = ['1', '2'].map(makeNode)
    let state = enterEdit(createCanvasProjection(input(nodes, [])))
    const positions = state.editNodes.map((node) => node.position)
    const edges = [link('a', '1', '2')]
    state = reconcileCanvasProjection(state, input(nodes, edges))
    expect(state.viewNodes).toHaveLength(2)
    expect(state.editNodes.map((node) => node.position)).toEqual(positions)
    state = reconcileCanvasProjection(state, input(nodes, []))
    expect(state.viewNodes).toHaveLength(0)
    expect(state.editNodes.map((node) => node.position)).toEqual(positions)
    expect(enterEdit(enterView(state)).editNodes).toHaveLength(2)
  })

  it('passes the previous component cache through graph changes', () => {
    const nodes = ['1', '2', '3', '4', '5'].map(makeNode)
    const edges = [link('a', '1', '2'), link('b', '3', '4')]
    let state = createCanvasProjection(input(nodes, edges))
    const unchanged = state.projection.components[1]
    state = reconcileCanvasProjection(
      state,
      input(nodes, [...edges, link('c', '1', '5')])
    )
    const after = state.projection.components[1]
    expect(after.signature).toBe(unchanged.signature)
    expect(
      after.boxes.map((box) => [box.id, box.x, box.y - after.boxes[0].y])
    ).toEqual(
      unchanged.boxes.map((box) => [
        box.id,
        box.x,
        box.y - unchanged.boxes[0].y,
      ])
    )
  })

  it('keeps newly staged nodes clear of moved Edit obstacles', () => {
    const nodes = ['1', '2'].map(makeNode)
    let state = enterEdit(createCanvasProjection(input(nodes, [])))
    state = setEditNodes(
      state,
      state.editNodes.map((node) => ({
        ...node,
        position: node.id === '1' ? { x: 350, y: 270 } : { x: 500, y: 270 },
      }))
    )
    state = reconcileCanvasProjection(
      state,
      input([...nodes, makeNode('3')], [])
    )
    const added = state.editNodes[2]
    for (const obstacle of state.editNodes.slice(0, 2)) {
      const dx = Math.abs(added.position.x - obstacle.position.x)
      const dy = Math.abs(added.position.y - obstacle.position.y)
      expect(dx >= 160 || dy >= 120).toBe(true)
    }
  })

  it('keeps an explicitly positioned import at its drop coordinates', () => {
    const existing = makeNode('1')
    const state = enterEdit(createCanvasProjection(input([existing], [])))
    const imported = makeNode('2')
    const next = reconcileCanvasProjection(state, {
      ...input([existing, imported], []),
      geometry: [{ imageId: 2, x: 1060, y: 620, w: 100, h: 60 }],
    })
    expect(at(next.editNodes, '2')).toEqual({ x: 1060, y: 620 })
  })

  it('updates an existing staged node after an explicit asset drop', () => {
    const original = makeNode('1')
    let state = enterEdit(createCanvasProjection(input([original], [])))
    const dropped = { ...original, position: { x: 640, y: 420 } }
    state = reconcileCanvasProjection(state, {
      ...input([dropped], []),
      geometry: [{ imageId: 1, x: 640, y: 420, w: 100, h: 60 }],
    })
    expect(at(state.editNodes, '1')).toEqual({ x: 640, y: 420 })
  })

  it('retains resized Edit geometry when metadata and nodes change', () => {
    const original = { ...makeNode('1'), height: 80 }
    let state = enterEdit(createCanvasProjection(input([original], [])))
    state = setEditNodes(
      state,
      applyNodeChanges(
        [
          {
            id: '1',
            type: 'dimensions',
            dimensions: { width: 300, height: 240 },
            setAttributes: true,
          },
        ],
        state.editNodes
      )
    )
    const resized = state.editNodes[0]
    expect(resized).toMatchObject({
      width: 300,
      height: 240,
      measured: { width: 300, height: 240 },
    })

    state = reconcileCanvasProjection(
      state,
      input([{ ...original, data: { label: 'updated' } }, makeNode('2')], [])
    )
    const [existing, added] = state.editNodes
    expect(existing.position).toEqual(resized.position)
    expect(existing.width).toBe(300)
    expect(existing.height).toBe(240)
    expect(existing.measured).toEqual(resized.measured)
    expect(existing.data.label).toBe('updated')
    expect(
      added.position.x >= existing.position.x + 300 ||
        added.position.x + (added.width ?? 0) <= existing.position.x ||
        added.position.y >= existing.position.y + 240 ||
        added.position.y + (added.height ?? 0) <= existing.position.y
    ).toBe(true)
  })

  it('retains measured-only Edit geometry instead of fresh model dimensions', () => {
    const original = { ...makeNode('1'), width: undefined, height: undefined }
    let state = enterEdit(createCanvasProjection(input([original], [])))
    state = setEditNodes(
      state,
      applyNodeChanges(
        [
          {
            id: '1',
            type: 'dimensions',
            dimensions: { width: 250, height: 180 },
          },
        ],
        state.editNodes
      )
    )
    state = reconcileCanvasProjection(
      state,
      input([{ ...makeNode('1'), measured: { width: 50, height: 40 } }], [])
    )
    expect(state.editNodes[0]).toMatchObject({
      width: undefined,
      height: undefined,
      measured: { width: 250, height: 180 },
    })
  })

  it('stages and reconciles a large repository as a batch', () => {
    const nodes = Array.from({ length: 2000 }, (_, i) =>
      makeNode(String(i + 1))
    )
    const edges = Array.from({ length: 50 }, (_, i) =>
      link(String(i), String(2 * i + 1), String(2 * i + 2))
    )
    let state = enterEdit(createCanvasProjection(input(nodes, edges)))
    expect(state.viewNodes).toHaveLength(100)
    expect(state.editNodes).toHaveLength(2000)
    const before = at(state.editNodes, '2000')
    state = reconcileCanvasProjection(
      state,
      input([...nodes, makeNode('2001')], edges)
    )
    expect(at(state.editNodes, '2000')).toEqual(before)
    expect(state.editNodes).toHaveLength(2001)
  })

  it('rejects missing relationship order and mismatched edit node sets', () => {
    const nodes = ['1', '2'].map(makeNode)
    expect(() =>
      createCanvasProjection({
        ...input(nodes, [link('a', '1', '2')]),
        pairingOrders: new Map(),
      })
    ).toThrow('missing pairing order')
    const state = enterEdit(createCanvasProjection(input(nodes, [])))
    expect(() => setEditNodes(state, [nodes[0], nodes[0]])).toThrow(
      'do not match'
    )
  })
})
