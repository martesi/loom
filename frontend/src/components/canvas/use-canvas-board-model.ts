import { type Edge, MarkerType, type Node } from '@xyflow/react'
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  CanvasData,
  GeometryUpdate,
} from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import type { CanvasBoardOwner } from './canvas-board-owner'
import { canvasOutcomeError } from './canvas-operation'
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
  setSelection: Dispatch<SetStateAction<Selection>>
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
  setSelection,
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
  const reconcileSelection = useCallback(
    (visibleNodes: readonly Node[], visibleEdges: readonly Edge[]) => {
      const ids = new Set(visibleNodes.map((node) => Number(node.id)))
      const nodeKeys = new Set(visibleNodes.map((node) => node.id))
      const edgeIds = new Set(visibleEdges.map((edge) => Number(edge.id)))
      const focused = document.activeElement
      const focusedNode =
        focused instanceof Element ? focused.closest('.react-flow__node') : null
      if (
        focusedNode &&
        host.current?.contains(focusedNode) &&
        !nodeKeys.has(focusedNode.getAttribute('data-id') ?? '')
      )
        host.current.focus()
      setSelection((current) => {
        if (current.surface !== 'canvas') return current
        const nextIds = current.ids.filter((id) => ids.has(id))
        const nextEdges = current.edges.filter((id) => edgeIds.has(id))
        if (
          nextIds.length === current.ids.length &&
          nextEdges.length === current.edges.length
        )
          return current
        return { ...current, ids: nextIds, edges: nextEdges }
      })
    },
    [host, setSelection]
  )
  const projection = useCanvasProjectionController({
    owner,
    nodes,
    setNodes,
    setEdges,
    host,
    flow,
    report: callbacks.current.report,
    cancelPointerGesture,
    reconcileSelection,
  })
  const projectionRef = useRef(projection)
  projectionRef.current = projection

  useEffect(() => {
    const cancelGesture = () => owner.cancelGesture()
    window.addEventListener('blur', cancelGesture)
    return () => window.removeEventListener('blur', cancelGesture)
  }, [owner])

  useEffect(() => {
    const board = owner.getSnapshot()
    if (board && board.data !== data) return
    const activeGestures = new Map<number, number>()
    let rendererActive = true
    const updateNodeGeometry = (imageId: number, geometry: GeometryUpdate) => {
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== String(imageId)) return node
          return {
            ...node,
            position: {
              x: geometry.x ?? node.position.x,
              y: geometry.y ?? node.position.y,
            },
            width: geometry.w ?? node.width,
            height: geometry.h ?? node.height,
            measured:
              geometry.w === null || geometry.h === null
                ? node.measured
                : { width: geometry.w, height: geometry.h },
          }
        })
      )
    }
    const graph = canvasProjectionGraph(
      data,
      renditionGeneration,
      (imageId, pointerId, direction, before, cancelPointer) => {
        if (!rendererActive) return null
        let token = 0
        const gestureToken = owner.beginResize(
          board?.data === data ? board : null,
          before,
          direction,
          pointerId,
          (geometry) => updateNodeGeometry(imageId, geometry),
          () => {
            activeGestures.delete(token)
            cancelPointer()
            setNodes((current) =>
              current.map((node) =>
                node.id === String(imageId)
                  ? {
                      ...node,
                      position: {
                        x: before.x ?? 0,
                        y: before.y ?? 0,
                      },
                      width: before.w ?? 150,
                      height: before.h ?? 110,
                      measured: {
                        width: before.w ?? 150,
                        height: before.h ?? 110,
                      },
                      dragging: false,
                    }
                  : node
              )
            )
          }
        )
        if (gestureToken === null) {
          if (owner.isLayoutPending())
            callbacks.current.report(
              new Error(
                'Canvas layout is being saved. Try resizing the image again.'
              )
            )
          return null
        }
        token = gestureToken
        activeGestures.set(token, pointerId)
        return token
      },
      (token, pointerId, geometry) => {
        if (!rendererActive || activeGestures.get(token) !== pointerId)
          return false
        return owner.updateResize(token, pointerId, geometry)
      },
      (token, pointerId, geometry) => {
        if (!rendererActive || activeGestures.get(token) !== pointerId) return
        activeGestures.delete(token)
        void owner
          .endResize(token, pointerId, geometry)
          .then((outcome) => {
            const error = canvasOutcomeError(outcome)
            if (error) callbacks.current.report(error)
          })
          .catch(callbacks.current.report)
      },
      (token, pointerId) => {
        if (activeGestures.get(token) !== pointerId) return
        activeGestures.delete(token)
        owner.cancelResize(token, pointerId)
      }
    )
    const history = owner.takeHistory()
    if (board && projectionRef.current.reconcile(board, graph, history)) {
      focusCanvasWhenEdgeRemoved(graph.edges, host.current)
      return () => {
        rendererActive = false
        for (const [token, pointerId] of activeGestures)
          owner.cancelResize(token, pointerId)
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
    if (board) reconcileSelection(legacyNodes, legacyEdges)
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
      for (const [token, pointerId] of activeGestures)
        owner.cancelResize(token, pointerId)
      activeGestures.clear()
    }
  }, [
    data,
    owner,
    renditionGeneration,
    callbacks,
    host,
    setEdges,
    setNodes,
    reconcileSelection,
  ])

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
