import type { Node, Viewport } from '@xyflow/react'
import { layoutChronologicalGraph } from '../../lib/chronological-layout'
import type { CanvasProjectionState } from './canvas-projection'

/** Stage loose images centrally, then place linked components outside them. */
export function spreadEditLayout(state: CanvasProjectionState): Node[] {
  const connected = new Set(state.viewNodes.map((node) => node.id))
  const loose = state.nodes.filter((node) => !connected.has(node.id))
  const sizes = loose.map((node) => ({
    id: node.id,
    width: node.width ?? node.measured?.width ?? 150,
    height: node.height ?? node.measured?.height ?? 110,
  }))
  const staged = layoutChronologicalGraph({
    nodes: sizes,
    edges: [],
    stagingCenter: { x: 0, y: 0 },
  }).staged
  const positions = new Map(
    staged.map((box) => [box.id, { x: box.x, y: box.y }])
  )
  const extent = staged.reduce(
    (max, box) => Math.max(max, Math.abs(box.x), Math.abs(box.x + box.width)),
    0
  )
  const nextY = [0, 0]
  state.projection.components.forEach((component, index) => {
    const boxes = component.boxes
    if (!boxes.length) return
    const minX = Math.min(...boxes.map((box) => box.x))
    const maxX = Math.max(...boxes.map((box) => box.x + box.width))
    const minY = Math.min(...boxes.map((box) => box.y))
    const maxY = Math.max(...boxes.map((box) => box.y + box.height))
    const side = index % 2
    const left = side === 0 ? extent + 120 : -extent - 120 - (maxX - minX)
    const top = nextY[side]
    nextY[side] += maxY - minY + 120
    for (const box of boxes)
      positions.set(box.id, { x: left + box.x - minX, y: top + box.y - minY })
  })
  return state.nodes.map((node) => {
    const position = positions.get(node.id)
    if (!position) throw new Error(`missing layout position for ${node.id}`)
    return { ...node, position }
  })
}

export function centeredViewport(
  nodes: readonly Node[],
  viewport: Viewport,
  size: { width: number; height: number }
): Viewport {
  if (!nodes.length) return viewport
  const minX = Math.min(...nodes.map((node) => node.position.x))
  const maxX = Math.max(
    ...nodes.map(
      (node) => node.position.x + (node.width ?? node.measured?.width ?? 150)
    )
  )
  const minY = Math.min(...nodes.map((node) => node.position.y))
  const maxY = Math.max(
    ...nodes.map(
      (node) => node.position.y + (node.height ?? node.measured?.height ?? 110)
    )
  )
  return {
    x: size.width / 2 - ((minX + maxX) / 2) * viewport.zoom,
    y: size.height / 2 - ((minY + maxY) / 2) * viewport.zoom,
    zoom: viewport.zoom,
  }
}
