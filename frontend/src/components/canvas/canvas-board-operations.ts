import type { Edge, Node, ReactFlowInstance } from '@xyflow/react'
import type { CanvasData } from '../../../bindings/loom/internal/service'
import { ImageService } from '../../../bindings/loom/internal/service'
import { computeSubgraphLayout, placeCluster } from '../../lib/layout'

const RELATION_DRAG_THRESHOLD = 5

export function targetAt(x: number, y: number): string | null {
  const group = [
    ...document.querySelectorAll<HTMLElement>('.react-flow__node-group'),
  ].find((node) => {
    const bounds = node.getBoundingClientRect()
    return (
      x >= bounds.left &&
      x <= bounds.right &&
      y >= bounds.top &&
      y <= bounds.bottom
    )
  })
  if (group)
    return (
      group
        .closest<HTMLElement>('.react-flow__node')
        ?.getAttribute('data-id') ?? null
    )
  const nodes = document
    .elementsFromPoint(x, y)
    .map((element) => element.closest<HTMLElement>('.react-flow__node'))
    .filter((node): node is HTMLElement => node !== null)
  const target =
    nodes.find((node) => node.classList.contains('react-flow__node-group')) ??
    nodes[0]
  return target?.getAttribute('data-id') ?? null
}

export function isRelationshipDrag(
  drag: { x: number; y: number },
  x: number,
  y: number,
  threshold: number
) {
  return Math.hypot(x - drag.x, y - drag.y) >= threshold
}

export function isCanvasRelationshipDrag(
  drag: { x: number; y: number },
  x: number,
  y: number
) {
  return isRelationshipDrag(drag, x, y, RELATION_DRAG_THRESHOLD)
}

export function validateRelationshipTarget(
  source: number,
  id: string,
  data: CanvasData,
  groupMembers: (id: number) => number[]
) {
  const targets = id.startsWith('set-')
    ? groupMembers(Number(id.slice(4)))
    : [Number(id)]
  const available = new Set(
    (data.images ?? [])
      .filter((image) => !image.trashed && !image.missing)
      .map((image) => image.id)
  )
  if (
    !available.has(source) ||
    !targets.length ||
    targets.some((target) => !available.has(target))
  )
    return { valid: false, reason: 'An image is unavailable' }
  if (targets.includes(source))
    return {
      valid: false,
      reason: id.startsWith('set-')
        ? 'A set cannot contain its source image'
        : 'An image cannot be related to itself',
    }
  if (
    targets.every((target) =>
      (data.relationships ?? []).some(
        (relationship) =>
          relationship.sourceImageId === source &&
          relationship.derivedImageId === target
      )
    )
  )
    return { valid: false, reason: 'This relationship already exists' }
  const cyclic = targets.some((target) => {
    const seen = new Set<number>()
    const stack = [target]
    while (stack.length) {
      const next = stack.pop()
      if (next === undefined) break
      if (next === source) return true
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(
        ...(data.relationships ?? [])
          .filter((relationship) => relationship.sourceImageId === next)
          .map((relationship) => relationship.derivedImageId)
      )
    }
    return false
  })
  return cyclic
    ? { valid: false, reason: 'This relationship would create a cycle' }
    : { valid: true, reason: undefined }
}

export async function arrangeCanvas(
  repoPath: string,
  nodes: Node[],
  edges: Edge[],
  data: CanvasData,
  reload: () => Promise<void>,
  requestedNodeIds?: string[]
) {
  const nodeIds = requestedNodeIds ?? nodes.map((node) => node.id)
  const clusterNodes = nodes.filter((node) => nodeIds.includes(node.id))
  if (!clusterNodes.length) return
  const positions = computeSubgraphLayout(
    clusterNodes.map((node) => ({
      id: node.id,
      width: node.width ?? node.measured?.width ?? 150,
      height: node.height ?? node.measured?.height ?? 110,
    })),
    edges
      .filter(
        (edge) => nodeIds.includes(edge.source) && nodeIds.includes(edge.target)
      )
      .map((edge) => ({ source: edge.source, target: edge.target }))
  )
  const existing = nodes
    .filter((node) => !nodeIds.includes(node.id))
    .map((node) => ({
      id: node.id,
      ...node.position,
      width: node.width ?? node.measured?.width ?? 150,
      height: node.height ?? node.measured?.height ?? 110,
    }))
  const minX = Math.min(...clusterNodes.map((node) => node.position.x))
  const minY = Math.min(...clusterNodes.map((node) => node.position.y))
  const placed = existing.length
    ? placeCluster(positions, existing)
    : new Map(
        [...positions].map(([id, position]) => [
          id,
          { x: position.x + minX, y: position.y + minY },
        ])
      )
  const updates = [...placed].flatMap(([id, position]) => {
    const node = nodes.find((candidate) => candidate.id === id)
    if (!node) return []
    if (node.type !== 'group') return [{ imageId: Number(id), ...position }]
    const group = (data.groups ?? []).find((item) => `set-${item.id}` === id)
    if (!group) return []
    const dx = position.x - node.position.x
    const dy = position.y - node.position.y
    return (data.images ?? [])
      .filter(
        (image) => (group.memberIds ?? []).includes(image.id) && image.placed
      )
      .map((image) => ({
        imageId: image.id,
        x: image.canvasX + dx,
        y: image.canvasY + dy,
      }))
  })
  await ImageService.SetPositions(repoPath, [
    ...new Map(updates.map((update) => [update.imageId, update])).values(),
  ])
  await reload()
}

export async function alignCanvas(
  axis: 'horizontal' | 'vertical',
  repoPath: string,
  nodes: Node[],
  data: CanvasData,
  reload: () => Promise<void>
) {
  const selected = nodes.filter((node) => node.selected)
  if (selected.length < 2) return
  const coordinate = axis === 'horizontal' ? 'y' : 'x'
  const average = Math.round(
    selected.reduce((sum, node) => sum + node.position[coordinate], 0) /
      selected.length
  )
  const updates = selected.flatMap((node) => {
    if (node.type !== 'group')
      return [
        {
          imageId: Number(node.id),
          x: axis === 'vertical' ? average : node.position.x,
          y: axis === 'horizontal' ? average : node.position.y,
        },
      ]
    const group = (data.groups ?? []).find(
      (item) => `set-${item.id}` === node.id
    )
    if (!group) return []
    const members = (data.images ?? []).filter(
      (image) => (group.memberIds ?? []).includes(image.id) && image.placed
    )
    const delta = average - node.position[coordinate]
    return members.map((image) => ({
      imageId: image.id,
      x: axis === 'vertical' ? image.canvasX + delta : image.canvasX,
      y: axis === 'horizontal' ? image.canvasY + delta : image.canvasY,
    }))
  })
  await ImageService.SetPositions(repoPath, [
    ...new Map(updates.map((update) => [update.imageId, update])).values(),
  ])
  await reload()
}

export function canvasCenter(
  flow: ReactFlowInstance,
  host: { current: HTMLDivElement | null }
) {
  const bounds = host.current?.getBoundingClientRect()
  return flow.screenToFlowPosition({
    x: (bounds?.left ?? 0) + (bounds?.width ?? 800) / 2,
    y: (bounds?.top ?? 0) + (bounds?.height ?? 600) / 2,
  })
}

export async function fitCanvas(
  flow: ReactFlowInstance,
  repoPath: string,
  nodes?: Node[]
) {
  await flow.fitView(nodes ? { nodes, padding: 0.2 } : { padding: 0.2 })
  await ImageService.SetViewport(repoPath, flow.getViewport())
}

export async function resetCanvasZoom(
  flow: ReactFlowInstance,
  host: { current: HTMLDivElement | null },
  repoPath: string
) {
  const center = canvasCenter(flow, host)
  await flow.setCenter(center.x, center.y, { zoom: 1 })
  await ImageService.SetViewport(repoPath, flow.getViewport())
}

export async function zoomCanvas(
  flow: ReactFlowInstance,
  repoPath: string,
  factor: number
) {
  await flow.setViewport({
    ...flow.getViewport(),
    zoom: Math.max(0.05, Math.min(4, flow.getZoom() * factor)),
  })
  await ImageService.SetViewport(repoPath, flow.getViewport())
}
