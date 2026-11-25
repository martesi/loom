import type { Edge, Node, Viewport, XYPosition } from '@xyflow/react'
import { useEffect, useRef, useState } from 'react'
import type { UndoResult } from '../../../bindings/loom/internal/service'
import type {
  AcceptedCanvasBoard,
  CanvasBoardOwner,
} from './canvas-board-owner'
import type { CanvasInternalMode } from './canvas-mode-policy'
import {
  arrangeEditProjection,
  type CanvasProjectionState,
  createCanvasProjection,
  enterEdit,
  enterView,
  reconcileCanvasProjection,
  setEditNodes,
  setProjectionViewport,
  setViewAnchor,
} from './canvas-projection'
import { applyProjectionUndo } from './canvas-projection-geometry'

export interface CanvasProjectionViewport {
  getViewport(): Viewport
  setViewport(viewport: Viewport): Promise<boolean>
}

interface Graph {
  nodes: Node[]
  edges: Edge[]
  pairingOrders: ReadonlyMap<string, number>
}

interface Props {
  owner: CanvasBoardOwner
  nodes: Node[]
  setNodes: (nodes: Node[]) => void
  setEdges: (edges: Edge[]) => void
  host: { current: HTMLDivElement | null }
  flow?: CanvasProjectionViewport
  report: (error: unknown) => void
  cancelPointerGesture?: () => void
}

/** Internal only: legacy remains active until the full mode mutation policy exists. */
export function useCanvasProjectionController(props: Props) {
  const current = useRef(props)
  current.current = props
  const state = useRef<CanvasProjectionState | null>(null)
  const source = useRef<{ board: AcceptedCanvasBoard; graph: Graph } | null>(
    null
  )
  const nodesBeforePublication = useRef<Node[] | null>(null)
  const lifetime = useRef<{ owner: CanvasBoardOwner } | null>(null)
  const [mode, setMode] = useState<CanvasInternalMode>('legacy')
  useEffect(() => {
    const active = { owner: props.owner }
    lifetime.current = active
    state.current = null
    source.current = null
    nodesBeforePublication.current = null
    props.owner.setMode('legacy')
    setMode('legacy')
    return () => {
      if (lifetime.current === active) lifetime.current = null
    }
  }, [props.owner])

  function size() {
    const host = current.current.host.current
    return { width: host?.clientWidth ?? 0, height: host?.clientHeight ?? 0 }
  }
  function publish(next: CanvasProjectionState) {
    state.current = next
    nodesBeforePublication.current = current.current.nodes
    current.current.setNodes(
      next.mode === 'view' ? next.viewNodes : next.editNodes
    )
    current.current.setEdges([...next.edges])
    setMode(next.mode)
  }
  function capture(next: CanvasProjectionState) {
    const { nodes, flow } = current.current
    if (next.mode === 'edit' && nodes !== nodesBeforePublication.current)
      next = setEditNodes(next, nodes)
    if (flow) next = setProjectionViewport(next, flow.getViewport(), size())
    return next
  }
  function updateViewport(viewport: Viewport) {
    if (state.current)
      state.current = setProjectionViewport(state.current, viewport, size())
  }
  function setAnchor(anchor: XYPosition | null) {
    if (state.current) state.current = setViewAnchor(state.current, anchor)
  }
  /** The action system calls this inside the owner's serialized queue. */
  async function arrangeEdit() {
    const { owner } = current.current
    if (owner.getMode() !== 'edit') return
    const input = source.current
    const previous = state.current
    if (!input || !previous || owner.getSnapshot() !== input.board)
      throw new Error('Canvas snapshot is not ready for arrangement')
    const before = capture(previous)
    const next = arrangeEditProjection(before)
    const geometry = (nodes: Node[]) =>
      nodes.map((node) => ({
        imageId: Number(node.id),
        ...node.position,
        w: node.width ?? node.measured?.width ?? 150,
        h: node.height ?? node.measured?.height ?? 110,
      }))
    await owner.commitDisplayedLayout(
      input.board,
      geometry(before.editNodes),
      geometry(next.editNodes),
      () => publish(next)
    )
  }
  async function transitionMode(target: 'view' | 'edit') {
    const { owner } = current.current
    const active = lifetime.current
    const isCurrent = () =>
      active !== null &&
      lifetime.current === active &&
      current.current.owner === owner &&
      active.owner === owner
    await owner.execute(async () => {
      if (!isCurrent()) return
      const input = source.current
      if (!input || owner.getSnapshot() !== input.board)
        throw new Error('Canvas snapshot is not ready for a mode transition')
      owner.cancelGesture()
      current.current.cancelPointerGesture?.()
      let next = state.current
      if (!next) {
        const viewport = current.current.flow?.getViewport() ?? {
          x: 0,
          y: 0,
          zoom: 1,
        }
        next = createCanvasProjection({
          ...input.graph,
          geometry: (input.board.snapshot.images ?? []).map(
            (item) => item.geometry
          ),
          viewport,
          viewportSize: size(),
        })
      } else next = capture(next)
      next = target === 'edit' ? enterEdit(next) : enterView(next)
      if (!isCurrent()) return
      owner.setMode(target)
      publish(next)
      const viewport = target === 'edit' ? next.editViewport : next.viewViewport
      if (!isCurrent()) return
      await current.current.flow?.setViewport(viewport)
    })
  }
  function reconcile(
    board: AcceptedCanvasBoard,
    graph: Graph,
    history: UndoResult[]
  ) {
    source.current = { board, graph }
    if (!state.current) return false
    const before = capture(state.current)
    let next = reconcileCanvasProjection(before, {
      ...graph,
      geometry: (board.snapshot.images ?? []).map((item) => item.geometry),
    })
    for (const result of history) {
      next = applyProjectionUndo(next, result, (nodes, geometry) => {
        const rows = new Map(geometry.map((row) => [String(row.imageId), row]))
        const defaults = new Map(graph.nodes.map((node) => [node.id, node]))
        return nodes.map((node) => {
          const row = rows.get(node.id)
          const fallback = defaults.get(node.id)
          if (!row || !fallback) return node
          const width = row.w ?? fallback.width
          const height = row.h ?? fallback.height
          return {
            ...node,
            position:
              row.x === null || row.y === null
                ? node.position
                : { x: row.x, y: row.y },
            width,
            height,
            measured:
              width === undefined || height === undefined
                ? undefined
                : { width, height },
          }
        })
      })
    }
    if (next.mode === 'view') next = compensateAnchor(before, next)
    publish(next)
    if (next.mode === 'view' && next.viewViewport !== before.viewViewport)
      void current.current.flow
        ?.setViewport(next.viewViewport)
        .catch(current.current.report)
    return true
  }
  return {
    mode,
    transitionMode,
    updateViewport,
    setAnchor,
    reconcile,
    arrangeEdit,
  }
}

function compensateAnchor(
  before: CanvasProjectionState,
  next: CanvasProjectionState
) {
  const anchor = before.viewAnchor ?? {
    x:
      (before.viewportSize.width / 2 - before.viewViewport.x) /
      before.viewViewport.zoom,
    y:
      (before.viewportSize.height / 2 - before.viewViewport.y) /
      before.viewViewport.zoom,
  }
  const nextById = new Map(next.viewNodes.map((node) => [node.id, node]))
  const candidates = before.viewNodes.filter((node) => nextById.has(node.id))
  candidates.sort(
    (a, b) =>
      Math.hypot(a.position.x - anchor.x, a.position.y - anchor.y) -
      Math.hypot(b.position.x - anchor.x, b.position.y - anchor.y)
  )
  const old = candidates[0]
  const moved = old && nextById.get(old.id)
  if (!old || !moved) return next
  const dx = moved.position.x - old.position.x
  const dy = moved.position.y - old.position.y
  if (!dx && !dy) return next
  return {
    ...next,
    // Only explicit anchors persist; the implicit anchor follows the viewport.
    viewAnchor: before.viewAnchor
      ? { x: anchor.x + dx, y: anchor.y + dy }
      : null,
    viewViewport: {
      ...next.viewViewport,
      x: next.viewViewport.x - dx * next.viewViewport.zoom,
      y: next.viewViewport.y - dy * next.viewViewport.zoom,
    },
  }
}
