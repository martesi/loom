import { type Edge, MarkerType, type Node } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasData } from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import type { CanvasBoardOwner, ResizeGesture } from './canvas-board-owner'
import { canvasProjectionGraph } from './canvas-projection-model'

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
}: Props) {
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const previousDisplayNodes = useRef(new Map<string, Node>())
  const selectedImageIds = useMemo(
    () => new Set(selection.ids),
    [selection.ids]
  )
  const selectedIdsList = selection.ids

  useEffect(() => {
    const board = owner.getSnapshot()
    const activeGestures = new Map<number, ResizeGesture>()
    let rendererActive = true
    const placed = (data.images ?? []).filter(
      (image) => image.placed && !image.trashed
    )
    const graph = canvasProjectionGraph(
      { ...data, images: placed },
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
    // React Flow needs the measurements to keep edges mounted across reloads.
    setNodes((previous) => {
      const measured = new Map(previous.map((node) => [node.id, node.measured]))
      return graph.nodes.map((node) => ({
        ...node,
        measured: measured.get(node.id),
      }))
    })
    const nextEdges = graph.edges
    const focused = document.activeElement
    if (
      focused instanceof SVGElement &&
      focused.matches('.react-flow__edge') &&
      host.current?.contains(focused) &&
      !nextEdges.some((edge) => edge.id === focused.getAttribute('data-id'))
    )
      host.current.focus()
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
      if (
        previous &&
        previous.data === node.data &&
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
      return { ...node, selected, className, zIndex }
    })
    previousDisplayNodes.current = new Map(
      mapped.map((node) => [node.id, node])
    )
    return mapped
  }, [nodes, isCanvasNodeSelected, target, hoveredNodeId])
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
    const placedIds = new Set(
      (data.images ?? [])
        .filter((image) => image.placed && !image.trashed)
        .map((image) => image.id)
    )
    return selection.ids.filter((id) => placedIds.has(id)).map(String)
  }, [data.images, selection.surface, selection.ids])

  return {
    owner,
    selectedIdsList,
    isCanvasNodeSelected,
    displayNodes,
    displayEdges,
    selectedCanvasNodeIds,
    setHoveredNodeId,
  }
}
