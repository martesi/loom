import { type Edge, MarkerType, type Node } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasData } from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import type { CanvasBoardOwner, ResizeGesture } from './canvas-board-owner'
import { applyHistoryToNodes } from './canvas-projection-geometry'
import { canvasProjectionGraph } from './canvas-projection-model'
import {
  type CanvasProjectionViewport,
  useCanvasProjectionController,
} from './use-canvas-projection-controller'

interface CanvasDropTarget {
  id: string
  valid: boolean
  kind: 'relationship'
  reason?: string
}

interface Callbacks {
  report: (error: unknown) => void
}

interface Props {
  data: CanvasData
  owner: CanvasBoardOwner
  renditionGeneration: number
  callbacks: { current: Callbacks }
  selection: Selection
  nodes: Node[]
  setNodes: (update: Node[] | ((nodes: Node[]) => Node[])) => void
  edges: Edge[]
  setEdges: (update: Edge[] | ((edges: Edge[]) => Edge[])) => void
  target: CanvasDropTarget | null
  host: { current: HTMLDivElement | null }
  flow?: CanvasProjectionViewport
  cancelPointerGesture?: () => void
}

export function useCanvasBoardModel({
  data,
  owner,
  renditionGeneration,
  callbacks,
  selection,
  nodes,
  setNodes,
  edges,
  setEdges,
  target,
  host,
  flow,
  cancelPointerGesture,
}: Props) {
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const previousDisplayNodes = useRef(new Map<string, Node>())
  const previousSourceNodes = useRef(new Map<string, Node>())
  const selectedImageIds = useMemo(
    () => new Set(selection.ids),
    [selection.ids]
  )
  const selectedIdsList = selection.ids
  const projection = useCanvasProjectionController({
    owner,
    nodes,
    setNodes,
    setEdges,
    host,
    flow,
    report: callbacks.current.report,
    cancelPointerGesture,
  })
  const projectionRef = useRef(projection)
  projectionRef.current = projection

  useEffect(() => {
    const board = owner.getSnapshot()
    if (board && board.data !== data) return
    const activeGestures = new Map<number, ResizeGesture>()
    let rendererActive = true
    const graph = canvasProjectionGraph(
      data,
      renditionGeneration,
      (imageId, x, y, w, h) => {
        if (!rendererActive) return
        const previous = activeGestures.get(imageId)
        if (previous) owner.cancelResize(previous)
        const gesture = owner.beginResize(board?.data === data ? board : null, {
          imageId,
          x,
          y,
          w,
          h,
        })
        if (gesture) {
          activeGestures.set(imageId, gesture)
        } else activeGestures.delete(imageId)
      },
      (imageId, x, y, w, h) => {
        const gesture = activeGestures.get(imageId)
        // Once submitted, the owner controls cancellation even if this renderer is rebuilt.
        activeGestures.delete(imageId)
        if (gesture)
          void owner
            .endResize(gesture, { imageId, x, y, w, h })
            .catch(callbacks.current.report)
      }
    )
    const history = owner.takeHistory()
    if (board && projectionRef.current.reconcile(board, graph, history)) {
      focusCanvasWhenEdgeRemoved(graph.edges, host.current)
      return () => {
        rendererActive = false
        for (const gesture of activeGestures.values())
          owner.cancelResize(gesture)
        activeGestures.clear()
      }
    }
    const placedIds = new Set(
      (data.images ?? [])
        .filter((image) => image.placed && !image.trashed)
        .map((image) => String(image.id))
    )
    const legacyNodes = graph.nodes.filter((node) => placedIds.has(node.id))
    const legacyEdges = graph.edges.filter(
      (edge) => placedIds.has(edge.source) && placedIds.has(edge.target)
    )
    // React Flow needs the measurements to keep edges mounted across reloads.
    setNodes((previous) => {
      const old = new Map(previous.map((node) => [node.id, node]))
      const initial: Node[] = legacyNodes.map((node) => {
        const prior = old.get(node.id)
        return history.length && prior
          ? {
              ...node,
              position: prior.position,
              width: prior.width,
              height: prior.height,
              measured: prior.measured,
            }
          : { ...node, measured: prior?.measured }
      })
      return history.reduce<Node[]>(
        (current, result) =>
          applyHistoryToNodes(current, result, (items, geometry) => {
            const byId = new Map(
              geometry.map((item) => [String(item.imageId), item])
            )
            const defaults = new Map(legacyNodes.map((node) => [node.id, node]))
            return items.map((node) => {
              const item = byId.get(node.id)
              const fallback = defaults.get(node.id)
              if (!item || !fallback) return node
              const width = item.w ?? fallback.width
              const height = item.h ?? fallback.height
              return {
                ...node,
                position:
                  item.x === null || item.y === null
                    ? fallback.position
                    : { x: item.x, y: item.y },
                width,
                height,
                measured:
                  width === undefined || height === undefined
                    ? undefined
                    : { width, height },
              }
            })
          }),
        initial
      )
    })
    const nextEdges = legacyEdges
    focusCanvasWhenEdgeRemoved(nextEdges, host.current)
    setEdges(nextEdges)
    return () => {
      rendererActive = false
      for (const gesture of activeGestures.values()) owner.cancelResize(gesture)
      activeGestures.clear()
    }
  }, [data, owner, renditionGeneration, callbacks, host, setEdges, setNodes])

  const isCanvasNodeSelected = useCallback(
    (node: Node) => {
      if (selection.surface !== 'canvas') return false
      return selectedImageIds.has(Number(node.id))
    },
    [selection.surface, selectedImageIds]
  )
  const displayNodes = useMemo(() => {
    const mapped = nodes.map((node) => {
      const selected = isCanvasNodeSelected(node)
      const className =
        target?.id === node.id
          ? target.valid
            ? 'ring-4 ring-green-500'
            : 'ring-4 ring-red-500'
          : ''
      const zIndex = node.id === hoveredNodeId ? 1001 : node.zIndex
      const previous = previousDisplayNodes.current.get(node.id)
      const previousSource = previousSourceNodes.current.get(node.id)
      if (
        previous &&
        previousSource?.data === node.data &&
        (previous.data.canResize !== false) === (projection.mode !== 'view') &&
        previous.position === node.position &&
        previous.measured === node.measured &&
        previous.width === node.width &&
        previous.height === node.height &&
        previous.selected === selected &&
        previous.className === className &&
        previous.dragging === node.dragging &&
        previous.zIndex === zIndex
      )
        return previous
      const data =
        projection.mode === 'view'
          ? { ...node.data, canResize: false }
          : node.data
      return { ...node, data, selected, className, zIndex }
    })
    previousDisplayNodes.current = new Map(
      mapped.map((node) => [node.id, node])
    )
    previousSourceNodes.current = new Map(nodes.map((node) => [node.id, node]))
    return mapped
  }, [nodes, isCanvasNodeSelected, target, hoveredNodeId, projection.mode])
  const displayEdges: Edge[] = useMemo(
    () =>
      edges.map((edge) => {
        const selected =
          selection.surface === 'canvas' &&
          selection.edges.includes(Number(edge.id))
        const color = selected ? 'var(--color-ink)' : 'var(--color-primary)'
        return {
          ...edge,
          selected,
          style: { stroke: color, strokeWidth: selected ? 3 : 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color },
        }
      }),
    [edges, selection.surface, selection.edges]
  )
  const selectedCanvasNodeIds = useMemo(() => {
    if (selection.surface !== 'canvas') return []
    const visibleIds =
      projection.mode === 'legacy'
        ? new Set(
            (data.images ?? [])
              .filter((image) => image.placed && !image.trashed)
              .map((image) => image.id)
          )
        : new Set(nodes.map((node) => Number(node.id)))
    return selection.ids.filter((id) => visibleIds.has(id)).map(String)
  }, [data.images, nodes, projection.mode, selection.surface, selection.ids])

  return {
    owner,
    selectedIdsList,
    isCanvasNodeSelected,
    displayNodes,
    displayEdges,
    selectedCanvasNodeIds,
    setHoveredNodeId,
    mode: projection.mode,
    graphOrder: projection.graphOrder,
    transitionMode: projection.transitionMode,
    arrangeEdit: projection.arrangeEdit,
    updateProjectionViewport: projection.updateViewport,
    setViewAnchor: projection.setAnchor,
  }
}

function focusCanvasWhenEdgeRemoved(
  edges: Edge[],
  host: HTMLDivElement | null
) {
  const focused = document.activeElement
  if (
    focused instanceof SVGElement &&
    focused.matches('.react-flow__edge') &&
    host?.contains(focused) &&
    !edges.some((edge) => edge.id === focused.getAttribute('data-id'))
  )
    host.focus()
}
