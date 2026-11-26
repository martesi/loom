import { t } from '@lingui/core/macro'
import {
  type Edge,
  getViewportForBounds,
  type Node,
  type ReactFlowInstance,
} from '@xyflow/react'
import type {
  CanvasData,
  GeometryUpdate,
} from '../../../bindings/loom/internal/service'
import { ImageService } from '../../../bindings/loom/internal/service'
import { computeSubgraphLayout, placeCluster } from '../../lib/layout'

const RELATION_DRAG_THRESHOLD = 5

export function targetAt(x: number, y: number): string | null {
  const nodes = document
    .elementsFromPoint(x, y)
    .map((element) => element.closest<HTMLElement>('.react-flow__node'))
    .filter((node): node is HTMLElement => node !== null)
  const target = nodes[0]
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
  _groupMembers: (id: number) => number[],
  excludedRelationshipId?: number
) {
  const targets = [Number(id)]
  const available = new Set(
    (data.images ?? [])
      .filter((image) => !image.trashed && !image.missing)
      .map((image) => image.id)
  )
  const relationships = (data.relationships ?? []).filter(
    (relationship) => relationship.id !== excludedRelationshipId
  )
  if (
    !available.has(source) ||
    !targets.length ||
    targets.some((target) => !available.has(target))
  )
    return { valid: false, reason: t`An image is unavailable` }
  if (targets.includes(source))
    return {
      valid: false,
      reason: t`An image cannot be related to itself`,
    }
  if (
    targets.every((target) =>
      relationships.some(
        (relationship) =>
          relationship.sourceImageId === source &&
          relationship.derivedImageId === target
      )
    )
  )
    return { valid: false, reason: t`This relationship already exists` }
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
        ...relationships
          .filter((relationship) => relationship.sourceImageId === next)
          .map((relationship) => relationship.derivedImageId)
      )
    }
    return false
  })
  return cyclic
    ? { valid: false, reason: t`This relationship would create a cycle` }
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
  const updates = [...placed].map(([id, position]) => ({
    imageId: Number(id),
    ...position,
  }))
  const uniqueUpdates = [
    ...new Map(updates.map((update) => [update.imageId, update])).values(),
  ]
  await ImageService.SetGeometry(
    repoPath,
    arrangeGeometryUpdates(uniqueUpdates, data)
  )
  await reload()
}

export function arrangeGeometryUpdates(
  updates: { imageId: number; x: number; y: number }[],
  data: CanvasData
): GeometryUpdate[] {
  const images = new Map((data.images ?? []).map((image) => [image.id, image]))
  return updates.map((update) => {
    const image = images.get(update.imageId)
    if (!image)
      throw new Error(`Missing image ${update.imageId} during arrange`)
    const hasSize = image.canvasW > 0 && image.canvasH > 0
    return {
      ...update,
      w: hasSize ? image.canvasW : null,
      h: hasSize ? image.canvasH : null,
    }
  })
}

export async function alignCanvas(
  axis: 'horizontal' | 'vertical',
  repoPath: string,
  nodes: Node[],
  _data: CanvasData,
  reload: () => Promise<void>
) {
  const selected = nodes.filter((node) => node.selected)
  if (selected.length < 2) return
  const coordinate = axis === 'horizontal' ? 'y' : 'x'
  const average = Math.round(
    selected.reduce((sum, node) => sum + node.position[coordinate], 0) /
      selected.length
  )
  const updates = selected.map((node) => ({
    imageId: Number(node.id),
    x: axis === 'vertical' ? average : node.position.x,
    y: axis === 'horizontal' ? average : node.position.y,
  }))
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
  host: { current: HTMLElement | null },
  nodes?: Node[],
  isCurrent: () => boolean = () => true
) {
  const nodeIds = (nodes ?? flow.getNodes()).map((node) => node.id)
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!isCurrent()) return false
    const bounds = host.current?.getBoundingClientRect()
    const measured =
      nodeIds.length > 0 &&
      nodeIds.every((id) => {
        const node = flow.getNode(id)
        return (
          (node?.measured?.width ?? 0) > 0 && (node?.measured?.height ?? 0) > 0
        )
      })
    if (measured && bounds && bounds.width > 0 && bounds.height > 0) {
      const nodeBounds = flow.getNodesBounds(nodeIds)
      if (nodeBounds.width <= 0 || nodeBounds.height <= 0)
        throw new Error('Canvas node bounds are empty and cannot be fitted.')
      const viewport = getViewportForBounds(
        nodeBounds,
        bounds.width,
        bounds.height,
        0.05,
        1,
        0.2
      )
      if (!isCurrent()) return false
      return flow.setViewport(viewport, { duration: 0 })
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  throw new Error('Canvas nodes were not measured in time to fit the view.')
}

export async function resetCanvasZoom(
  flow: ReactFlowInstance,
  host: { current: HTMLDivElement | null },
  _repoPath: string,
  _persist = true
) {
  const center = canvasCenter(flow, host)
  const bounds = host.current?.getBoundingClientRect()
  return flow.setViewport(
    {
      x: (bounds?.width ?? 0) / 2 - center.x,
      y: (bounds?.height ?? 0) / 2 - center.y,
      zoom: 1,
    },
    { duration: 0 }
  )
}

export async function zoomCanvas(
  flow: ReactFlowInstance,
  _repoPath: string,
  factor: number,
  _persist = true
) {
  return flow.setViewport(
    {
      ...flow.getViewport(),
      zoom: Math.max(0.05, Math.min(4, flow.getZoom() * factor)),
    },
    { duration: 0 }
  )
}
