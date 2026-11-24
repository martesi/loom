import type { Edge, Node, Viewport, XYPosition } from '@xyflow/react'
import type { GeometryUpdate } from '../../../bindings/loom/internal/service'
import {
  type ChronologicalProjection,
  layoutChronologicalGraph,
} from '../../lib/chronological-layout'
import type { LayoutBox, LayoutNode } from '../../lib/layout'
import { clearObstacles } from '../../lib/staging-obstacles'

export interface CanvasProjectionInput {
  /** Display-ready React Flow nodes and edges, with group mapping already applied. */
  nodes: readonly Node[]
  edges: readonly Edge[]
  /** Relationship ID to immutable pairing order, including collapsed edges. */
  pairingOrders: ReadonlyMap<string, number>
  /** Exact GetGeometry result, not the lossy CanvasData coordinates. */
  geometry: readonly GeometryUpdate[]
  viewport: Viewport
  viewportSize: { width: number; height: number }
  previous?: ChronologicalProjection
}

export interface CanvasProjectionState {
  mode: 'view' | 'edit'
  nodes: readonly Node[]
  edges: readonly Edge[]
  pairingOrders: ReadonlyMap<string, number>
  projection: ChronologicalProjection
  viewNodes: Node[]
  editNodes: Node[]
  expectedGeometry: ReadonlyMap<number, GeometryUpdate>
  viewViewport: Viewport
  editViewport: Viewport
  editInitialized: boolean
  viewportSize: { width: number; height: number }
  /** A canvas-space anchor chosen by the consumer, independent of viewport. */
  viewAnchor: XYPosition | null
}

/**
 * Start in View. Inputs must describe the same graph revision, including the
 * GetGeometry snapshot. The caller must cancel gestures on graph or data changes
 * and reload after a stale service error. No service calls are made here.
 */
export function createCanvasProjection(
  input: CanvasProjectionInput
): CanvasProjectionState {
  const projection = project(
    input.nodes,
    input.edges,
    input.pairingOrders,
    input.previous
  )
  return {
    mode: 'view',
    nodes: input.nodes,
    edges: input.edges,
    pairingOrders: input.pairingOrders,
    projection,
    viewNodes: viewNodes(input.nodes, projection),
    editNodes: [],
    expectedGeometry: geometryMap(input.geometry),
    viewViewport: input.viewport,
    editViewport: input.viewport,
    editInitialized: false,
    viewportSize: input.viewportSize,
    viewAnchor: null,
  }
}

/** Reconcile a fresh graph and exact geometry baseline without moving Edit nodes. */
export function reconcileCanvasProjection(
  state: CanvasProjectionState,
  input: Pick<
    CanvasProjectionInput,
    'nodes' | 'edges' | 'pairingOrders' | 'geometry'
  >
): CanvasProjectionState {
  const projection = project(
    input.nodes,
    input.edges,
    input.pairingOrders,
    state.projection
  )
  const nextViewNodes = viewNodes(input.nodes, projection)
  let editNodes = state.editNodes
  if (state.mode === 'edit') {
    const previous = new Map(state.editNodes.map((node) => [node.id, node]))
    const existing = input.nodes.flatMap((node) => {
      const old = previous.get(node.id)
      return old ? [{ ...node, position: old.position }] : []
    })
    const added = input.nodes.filter((node) => !previous.has(node.id))
    const staged = stageNodes(
      added,
      existing.map(nodeBox),
      center(state.editViewport, state.viewportSize)
    )
    const byId = new Map(
      [...existing, ...staged].map((node) => [node.id, node])
    )
    editNodes = input.nodes.map((node) => {
      const result = byId.get(node.id)
      if (!result) throw new Error(`missing edit node: ${node.id}`)
      return result
    })
  }
  return {
    ...state,
    nodes: input.nodes,
    edges: input.edges,
    pairingOrders: input.pairingOrders,
    projection,
    viewNodes: nextViewNodes,
    editNodes,
    expectedGeometry: geometryMap(input.geometry),
  }
}

/**
 * Derive a fresh Edit display on every entry: connected nodes start at View
 * positions, and orphans are staged. This does not persist any geometry.
 */
export function enterEdit(state: CanvasProjectionState): CanvasProjectionState {
  if (state.mode === 'edit') return state
  const editViewport = state.editInitialized
    ? state.editViewport
    : state.viewViewport
  const paired = new Map(state.viewNodes.map((node) => [node.id, node]))
  const staged = stageNodes(
    state.nodes.filter((node) => !paired.has(node.id)),
    state.viewNodes.map(nodeBox),
    center(editViewport, state.viewportSize)
  )
  const byId = new Map(
    [...state.viewNodes, ...staged].map((node) => [node.id, node])
  )
  return {
    ...state,
    mode: 'edit',
    editViewport,
    editInitialized: true,
    editNodes: state.nodes.map((node) => {
      const result = byId.get(node.id)
      if (!result) throw new Error(`missing edit node: ${node.id}`)
      return result
    }),
  }
}

/** Accept React Flow's current Edit nodes after a drag or resize. */
export function setEditNodes(
  state: CanvasProjectionState,
  nodes: Node[]
): CanvasProjectionState {
  if (state.mode !== 'edit') throw new Error('edit nodes require Edit')
  const ids = new Set(state.nodes.map((node) => node.id))
  if (nodes.length !== ids.size || nodes.some((node) => !ids.delete(node.id)))
    throw new Error('edit nodes do not match the graph')
  return { ...state, editNodes: nodes }
}

export function enterView(state: CanvasProjectionState): CanvasProjectionState {
  return state.mode === 'view' ? state : { ...state, mode: 'view' }
}

export function setProjectionViewport(
  state: CanvasProjectionState,
  viewport: Viewport,
  viewportSize = state.viewportSize
): CanvasProjectionState {
  return state.mode === 'view'
    ? { ...state, viewViewport: viewport, viewportSize }
    : { ...state, editViewport: viewport, viewportSize }
}

export function setViewAnchor(
  state: CanvasProjectionState,
  anchor: XYPosition | null
): CanvasProjectionState {
  return { ...state, viewAnchor: anchor }
}

function project(
  nodes: readonly Node[],
  edges: readonly Edge[],
  orders: ReadonlyMap<string, number>,
  previous?: ChronologicalProjection
) {
  return layoutChronologicalGraph({
    nodes: nodes.map(nodeSize),
    previous,
    edges: edges.map((edge) => {
      const pairingOrder = orders.get(edge.id)
      if (pairingOrder === undefined)
        throw new Error(`missing pairing order: ${edge.id}`)
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        pairingOrder,
      }
    }),
  })
}

function viewNodes(
  nodes: readonly Node[],
  projection: ChronologicalProjection
): Node[] {
  const boxes = new Map(
    projection.components.flatMap((component) =>
      component.boxes.map((box) => [box.id, box] as const)
    )
  )
  return nodes.flatMap((node) => {
    const box = boxes.get(node.id)
    return box ? [{ ...node, position: { x: box.x, y: box.y } }] : []
  })
}

function nodeSize(node: Node): LayoutNode {
  return {
    id: node.id,
    width: node.width ?? node.measured?.width ?? 150,
    height: node.height ?? node.measured?.height ?? 110,
  }
}

function nodeBox(node: Node): LayoutBox {
  return { ...nodeSize(node), ...node.position }
}

function center(
  viewport: Viewport,
  size: { width: number; height: number }
): XYPosition {
  if (
    !Number.isFinite(viewport.zoom) ||
    viewport.zoom <= 0 ||
    !Number.isFinite(viewport.x) ||
    !Number.isFinite(viewport.y) ||
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width < 0 ||
    size.height < 0
  )
    throw new Error('invalid viewport')
  return {
    x: (size.width / 2 - viewport.x) / viewport.zoom,
    y: (size.height / 2 - viewport.y) / viewport.zoom,
  }
}

function stageNodes(
  nodes: readonly Node[],
  obstacles: LayoutBox[],
  at: XYPosition
): Node[] {
  if (!nodes.length) return []
  // Use the layout's deterministic orphan grid, then move it as a unit around
  // the actual Edit obstacles rather than the possibly different View layout.
  const staged = layoutChronologicalGraph({
    nodes: nodes.map(nodeSize),
    edges: [],
    stagingCenter: at,
  }).staged
  const { minX, minY, maxX, maxY } = staged.reduce(
    (bounds, box) => ({
      minX: Math.min(bounds.minX, box.x),
      minY: Math.min(bounds.minY, box.y),
      maxX: Math.max(bounds.maxX, box.x + box.width),
      maxY: Math.max(bounds.maxY, box.y + box.height),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  )
  const rect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  const choices = (['up', 'down', 'left', 'right'] as const).map((direction) =>
    clearObstacles(rect, obstacles, direction)
  )
  choices.sort(
    (a, b) =>
      Math.hypot(a.x - minX, a.y - minY) - Math.hypot(b.x - minX, b.y - minY)
  )
  const selected = choices[0]
  // Match the coordinate range enforced by chronological-layout.
  if (
    Math.abs(selected.x) > 1e12 ||
    Math.abs(selected.y) > 1e12 ||
    Math.abs(selected.x + rect.width) > 1e12 ||
    Math.abs(selected.y + rect.height) > 1e12
  )
    throw new Error('staging exceeds supported layout range')
  const positions = new Map(
    staged.map((box) => [
      box.id,
      { x: box.x + selected.x - minX, y: box.y + selected.y - minY },
    ])
  )
  return nodes.map((node) => {
    const position = positions.get(node.id)
    if (!position) throw new Error(`missing staged node: ${node.id}`)
    return { ...node, position }
  })
}

function geometryMap(
  geometry: readonly GeometryUpdate[]
): ReadonlyMap<number, GeometryUpdate> {
  const result = new Map<number, GeometryUpdate>()
  for (const item of geometry) {
    if (result.has(item.imageId))
      throw new Error(`duplicate geometry: ${item.imageId}`)
    result.set(item.imageId, { ...item })
  }
  return result
}
