import type { Edge, Node, Viewport, XYPosition } from '@xyflow/react'
import { useEffect, useRef, useState } from 'react'
import type {
  CanvasData,
  UndoResult,
} from '../../../bindings/loom/internal/service'
import type {
  AcceptedCanvasBoard,
  CanvasBoardOwner,
} from './canvas-board-owner'
import type { CanvasInternalMode } from './canvas-mode-policy'
import {
  readCanvasModeViewport,
  resolveCanvasModeViewports,
} from './canvas-mode-viewport'
import {
  arrangeEditProjection,
  arrangeEditSelection,
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
  reconcileSelection: (nodes: readonly Node[], edges: readonly Edge[]) => void
  startInView?: boolean
  projectGraph?: (data: CanvasData) => Graph
}

/** The public route opts into View; internal consumers can still exercise legacy behavior. */
export function useCanvasProjectionController(props: Props) {
  const current = useRef(props)
  current.current = props
  const state = useRef<CanvasProjectionState | null>(null)
  const source = useRef<{ board: AcceptedCanvasBoard; graph: Graph } | null>(
    null
  )
  const nodesBeforePublication = useRef<Node[] | null>(null)
  const lifetime = useRef<{ owner: CanvasBoardOwner } | null>(null)
  const initialViewportFrame = useRef(0)
  const [mode, setMode] = useState<CanvasInternalMode>('legacy')
  useEffect(() => {
    if (initialViewportFrame.current)
      cancelAnimationFrame(initialViewportFrame.current)
    const active = { owner: props.owner }
    lifetime.current = active
    state.current = null
    source.current = null
    nodesBeforePublication.current = null
    props.owner.setMode('legacy')
    setMode('legacy')
    return () => {
      if (initialViewportFrame.current)
        cancelAnimationFrame(initialViewportFrame.current)
      initialViewportFrame.current = 0
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
    const nodes = next.mode === 'view' ? next.viewNodes : next.editNodes
    current.current.reconcileSelection(nodes, next.edges)
    current.current.setNodes(nodes)
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
    if (state.current) {
      state.current = setProjectionViewport(state.current, viewport, size())
    }
  }
  function scheduleInitialViewport(
    projection: CanvasProjectionState,
    active: { owner: CanvasBoardOwner }
  ) {
    if (!current.current.flow) return
    if (initialViewportFrame.current)
      cancelAnimationFrame(initialViewportFrame.current)
    initialViewportFrame.current = requestAnimationFrame(() => {
      initialViewportFrame.current = 0
      if (
        lifetime.current !== active ||
        current.current.owner !== active.owner ||
        state.current !== projection
      )
        return
      void current.current.flow
        ?.setViewport(projection.viewViewport)
        .catch(current.current.report)
    })
  }
  function createProjection(
    graph: Graph,
    board: AcceptedCanvasBoard,
    viewport: Viewport
  ) {
    const repoPath = current.current.owner.repoPath
    const modeViewports = resolveCanvasModeViewports(
      current.current.owner.getRepositoryViewport() ?? viewport,
      readCanvasModeViewport(repoPath, 'view'),
      readCanvasModeViewport(repoPath, 'edit')
    )
    const initial = createCanvasProjection({
      ...graph,
      geometry: (board.snapshot.images ?? []).map((item) => item.geometry),
      viewport: modeViewports.view,
      viewportSize: size(),
    })
    return {
      ...initial,
      viewViewport: modeViewports.view,
      editViewport: modeViewports.edit,
      editInitialized: true,
    }
  }
  function setAnchor(anchor: XYPosition | null) {
    if (state.current) state.current = setViewAnchor(state.current, anchor)
  }
  /** The action system calls this inside the owner's serialized queue. */
  async function arrangeEdit(selectedIds?: readonly string[]) {
    const { owner } = current.current
    if (owner.getMode() !== 'edit') return
    const input = source.current
    const previous = state.current
    const active = lifetime.current
    if (!input || !previous || owner.getSnapshot() !== input.board)
      throw new Error('Canvas snapshot is not ready for arrangement')
    const before = capture(previous)
    const next = selectedIds
      ? arrangeEditSelection(before, selectedIds)
      : arrangeEditProjection(before)
    const persistedGeometry = new Map(
      (input.board.snapshot.images ?? []).map((image) => [
        image.id,
        image.geometry,
      ])
    )
    const geometry = (nodes: Node[]) =>
      nodes.map((node) => {
        const imageId = Number(node.id)
        const stored = persistedGeometry.get(imageId)
        if (!stored)
          throw new Error(`Missing stored geometry for image ${imageId}`)
        return {
          imageId,
          ...node.position,
          w: stored.w,
          h: stored.h,
        }
      })
    await owner.commitDisplayedLayout(
      input.board,
      geometry(before.editNodes),
      geometry(next.editNodes),
      () => {
        const latest = state.current
        if (
          !active ||
          lifetime.current !== active ||
          !latest ||
          latest.mode !== 'edit'
        )
          return
        const positions = new Map(
          next.editNodes.map((node) => [node.id, node.position])
        )
        const currentEdit = capture(latest)
        publish(
          setEditNodes(
            currentEdit,
            currentEdit.editNodes.map((node) => {
              const position = positions.get(node.id)
              return position ? { ...node, position } : node
            })
          )
        )
      }
    )
  }
  async function transitionMode(target: 'view' | 'edit') {
    const { owner } = current.current
    const requestRevision = owner.requestModeTransition(target)
    const active = lifetime.current
    const isCurrent = () =>
      active !== null &&
      lifetime.current === active &&
      current.current.owner === owner &&
      active.owner === owner &&
      owner.getModeRequestRevision() === requestRevision
    await owner.execute(async () => {
      if (!isCurrent()) return
      const board = owner.getSnapshot()
      if (!board)
        throw new Error('Canvas snapshot is not ready for a mode transition')
      const graph =
        current.current.projectGraph?.(board.data) ?? source.current?.graph
      if (!graph)
        throw new Error('Canvas graph is not ready for a mode transition')
      const input = { board, graph }
      source.current = input
      owner.cancelGesture()
      current.current.cancelPointerGesture?.()
      let next = state.current
      if (!next) {
        const viewport = current.current.flow?.getViewport() ?? {
          x: 0,
          y: 0,
          zoom: 1,
        }
        next = createProjection(input.graph, input.board, viewport)
      } else {
        next = reconcileCanvasProjection(capture(next), {
          ...input.graph,
          geometry: (input.board.snapshot.images ?? []).map(
            (item) => item.geometry
          ),
        })
      }
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
    if (!state.current && !current.current.startInView) return false
    if (!state.current) {
      const viewport = current.current.flow?.getViewport() ?? {
        x: 0,
        y: 0,
        zoom: 1,
      }
      const initial = createProjection(graph, board, viewport)
      current.current.owner.setMode('view')
      publish(initial)
      const active = lifetime.current
      if (active && current.current.owner === active.owner)
        scheduleInitialViewport(initial, active)
      return true
    }
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
  const graphOrder =
    state.current?.projection.components.flatMap((component) =>
      component.boxes.map((box) => Number(box.id))
    ) ?? []
  return {
    mode,
    graphOrder,
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
