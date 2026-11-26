import {
  type Edge,
  getViewportForBounds,
  type Node,
  type Viewport,
  type XYPosition,
} from '@xyflow/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CanvasData,
  UndoResult,
} from '../../../bindings/loom/internal/service'
import { ImageService } from '../../../bindings/loom/internal/service'
import type {
  AcceptedCanvasBoard,
  CanvasBoardOwner,
} from './canvas-board-owner'
import type { CanvasInternalMode } from './canvas-mode-policy'
import {
  readCanvasModeViewport,
  resolveCanvasModeViewports,
  writeCanvasModeViewport,
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
import type {
  CanvasViewportEventOrigin,
  CanvasViewportIntentToken,
  CanvasViewportOrigin,
  CanvasViewportPhase,
} from './canvas-viewport-origin'

export interface CanvasProjectionViewport {
  getViewport(): Viewport
  setViewport(
    viewport: Viewport,
    options?: { duration?: number }
  ): Promise<boolean>
  getNode?(id: string): Node | undefined
  getNodesBounds?(nodes: string[]): {
    x: number
    y: number
    width: number
    height: number
  }
}

interface ViewportTask {
  id: number
  owner: CanvasBoardOwner
  lifetime: { owner: CanvasBoardOwner; activationEpoch: number }
  activationEpoch: number
  repoPath: string
  mode: 'view' | 'edit'
  modeRequestRevision: number
  origin: 'restore' | 'initial-fit' | 'anchor' | 'user'
  kind: 'set' | 'fit'
  viewport?: Viewport
  fitNodeIds?: string[]
  token?: CanvasViewportIntentToken
  commitUserViewport: boolean
  attempts: number
  measurementAttempts: number
  settled: boolean
  resolve: (applied: boolean) => void
}

export interface CanvasViewportCommand {
  id: number
  owner: CanvasBoardOwner
  repoPath: string
  mode: CanvasInternalMode
  modeRequestRevision: number
  activationEpoch: number
  waitForViewport: Promise<void>
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
  const lifetime = useRef<{
    owner: CanvasBoardOwner
    activationEpoch: number
  } | null>(null)
  const viewportRequestId = useRef(0)
  const pendingViewportTask = useRef<ViewportTask | null>(null)
  const activeViewportTask = useRef<ViewportTask | null>(null)
  const viewportTaskInFlight = useRef(false)
  const viewportTaskIdle = useRef<Promise<void> | null>(null)
  const viewportReady = useRef(!props.startInView)
  const viewportRetryFrame = useRef(0)
  const userViewportGesture = useRef(false)
  const viewportCommandOrigin = useRef<number | null>(null)
  const viewportCommandId = useRef(0)
  const viewportGestureId = useRef(0)
  const viewportIntentId = useRef(0)
  const viewportIntentByEvent = useRef(
    new WeakMap<Event, CanvasViewportIntentToken>()
  )
  const currentViewportIntent = useRef<CanvasViewportIntentToken | null>(null)
  const lastUserViewport = useRef<{
    token: CanvasViewportIntentToken
    viewport: Viewport
  } | null>(null)
  const [mode, setMode] = useState<CanvasInternalMode>('legacy')
  const invalidatePendingViewportTask = useCallback(() => {
    viewportRequestId.current++
    if (viewportRetryFrame.current)
      cancelAnimationFrame(viewportRetryFrame.current)
    viewportRetryFrame.current = 0
    const pending = pendingViewportTask.current
    pendingViewportTask.current = null
    if (pending && !pending.settled) {
      pending.settled = true
      pending.resolve(false)
    }
  }, [])
  useEffect(() => {
    invalidatePendingViewportTask()
    const active = {
      owner: props.owner,
      activationEpoch: props.owner.getActivationEpoch(),
    }
    lifetime.current = active
    state.current = null
    source.current = null
    nodesBeforePublication.current = null
    props.owner.setMode('legacy')
    setMode('legacy')
    return () => {
      invalidatePendingViewportTask()
      if (lifetime.current === active) lifetime.current = null
    }
  }, [props.owner, invalidatePendingViewportTask])

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
    if (flow && !pendingViewportTask.current)
      next = setProjectionViewport(next, flow.getViewport(), size())
    return next
  }
  function updateViewport(
    viewport: Viewport,
    origin: CanvasViewportOrigin = 'external',
    phase: CanvasViewportPhase = 'end',
    token?: CanvasViewportIntentToken
  ): Promise<boolean> | undefined {
    if (origin === 'stale') return
    if (origin === 'user' && !isViewportIntentCurrent(token)) return
    if (
      origin !== 'user' &&
      origin !== 'command' &&
      (pendingViewportTask.current !== null ||
        activeViewportTask.current !== null)
    )
      return
    if (state.current) {
      state.current = setProjectionViewport(state.current, viewport, size())
    }
    if (origin !== 'user') return
    if (token) lastUserViewport.current = { token, viewport }
    if (viewportTaskInFlight.current)
      return requestViewportTask('user', 'set', viewport, {
        token,
        commitUserViewport: phase === 'end',
      })
    if (phase === 'end') {
      persistUserViewport(token, viewport)
    }
  }
  function isViewportIntentCurrent(token?: CanvasViewportIntentToken) {
    const owner = current.current.owner
    return Boolean(
      token &&
        currentViewportIntent.current?.id === token.id &&
        token.owner === owner &&
        owner.isActive?.() !== false &&
        token.activationEpoch === owner.getActivationEpoch() &&
        token.repoPath === owner.repoPath &&
        token.mode === owner.getMode() &&
        token.modeRequestRevision === owner.getModeRequestRevision()
    )
  }
  function persistUserViewport(
    token: CanvasViewportIntentToken | undefined,
    viewport: Viewport
  ) {
    if (!isViewportIntentCurrent(token) || !token) return
    if (token.mode === 'legacy')
      void ImageService.SetViewport(token.repoPath, viewport).catch(
        current.current.report
      )
    else writeCanvasModeViewport(token.repoPath, token.mode, viewport)
  }
  function persistLastUserViewport() {
    const last = lastUserViewport.current
    if (last && isViewportIntentCurrent(last.token))
      persistUserViewport(last.token, last.viewport)
    else {
      const token = currentViewportIntent.current ?? undefined
      const viewport = current.current.flow?.getViewport()
      if (viewport && isViewportIntentCurrent(token))
        persistUserViewport(token, viewport)
    }
    lastUserViewport.current = null
    currentViewportIntent.current = null
    userViewportGesture.current = false
  }
  function captureUserViewportInput(event: Event) {
    persistLastUserViewport()
    invalidatePendingViewportTask()
    viewportCommandOrigin.current = null
    const owner = current.current.owner
    userViewportGesture.current = true
    const token: CanvasViewportIntentToken = {
      id: ++viewportIntentId.current,
      gestureId: ++viewportGestureId.current,
      owner,
      repoPath: owner.repoPath,
      mode: owner.getMode(),
      modeRequestRevision: owner.getModeRequestRevision(),
      activationEpoch: owner.getActivationEpoch(),
    }
    currentViewportIntent.current = token
    viewportIntentByEvent.current.set(event, token)
    return token
  }
  function associateUserViewportEvent(event: Event) {
    const token = currentViewportIntent.current
    if (token && isViewportIntentCurrent(token))
      viewportIntentByEvent.current.set(event, token)
  }
  function settleViewportTask(task: ViewportTask, applied: boolean) {
    if (task.settled) return
    task.settled = true
    task.resolve(applied)
  }
  function viewportTaskIsCurrent(task: ViewportTask) {
    return (
      viewportReady.current &&
      pendingViewportTask.current === task &&
      task.id === viewportRequestId.current &&
      lifetime.current === task.lifetime &&
      current.current.owner === task.owner &&
      task.owner.isActive?.() !== false &&
      task.activationEpoch === task.owner.getActivationEpoch() &&
      task.lifetime.activationEpoch === task.activationEpoch &&
      task.owner.repoPath === task.repoPath &&
      task.owner.getMode() === task.mode &&
      task.owner.getModeRequestRevision() === task.modeRequestRevision &&
      (task.origin !== 'user' || isViewportIntentCurrent(task.token))
    )
  }
  function drainViewportTasks() {
    if (viewportTaskInFlight.current || !viewportReady.current) return
    const task = pendingViewportTask.current
    if (!task) return
    if (!viewportTaskIsCurrent(task)) {
      pendingViewportTask.current = null
      settleViewportTask(task, false)
      return
    }
    const flow = current.current.flow
    if (!flow) {
      pendingViewportTask.current = null
      settleViewportTask(task, true)
      drainViewportTasks()
      return
    }
    if (task.kind === 'fit') {
      const target = getMeasuredFitViewport(flow, task.fitNodeIds ?? [], size())
      if (!target) {
        if (task.measurementAttempts >= 60) {
          failViewportTask(
            task,
            new Error('Canvas nodes were not measured in time to fit the view.')
          )
          return
        }
        task.measurementAttempts++
        viewportRetryFrame.current = requestAnimationFrame(() => {
          viewportRetryFrame.current = 0
          drainViewportTasks()
        })
        return
      }
      task.viewport = target
      task.kind = 'set'
    }
    const currentViewport = flow.getViewport()
    const alreadyAtTarget =
      task.kind === 'set' &&
      task.viewport !== undefined &&
      sameViewport(currentViewport, task.viewport)
    if (alreadyAtTarget) {
      pendingViewportTask.current = null
      if (task.commitUserViewport && task.viewport)
        persistUserViewport(task.token, task.viewport)
      settleViewportTask(task, true)
      return
    }
    viewportTaskInFlight.current = true
    activeViewportTask.current = task
    let releaseIdle = () => {}
    viewportTaskIdle.current = new Promise<void>((resolve) => {
      releaseIdle = resolve
    })
    let operation: Promise<boolean> | undefined
    try {
      if (!viewportTaskIsCurrent(task)) {
        releaseIdle()
        viewportTaskIdle.current = null
        viewportTaskInFlight.current = false
        activeViewportTask.current = null
        settleViewportTask(task, false)
        drainViewportTasks()
        return
      }
      operation = task.viewport
        ? flow.setViewport(task.viewport, { duration: 0 })
        : undefined
    } catch (error) {
      releaseIdle()
      viewportTaskIdle.current = null
      viewportTaskInFlight.current = false
      activeViewportTask.current = null
      failViewportTask(task, error)
      return
    }
    if (!operation) {
      releaseIdle()
      viewportTaskIdle.current = null
      viewportTaskInFlight.current = false
      activeViewportTask.current = null
      failViewportTask(
        task,
        new Error('Canvas viewport operation is not available.')
      )
      return
    }
    void operation.then(
      (applied) => {
        releaseIdle()
        viewportTaskIdle.current = null
        viewportTaskInFlight.current = false
        activeViewportTask.current = null
        if (!viewportTaskIsCurrent(task)) {
          settleViewportTask(task, false)
          drainViewportTasks()
          return
        }
        if (!applied) {
          if (task.attempts < 2) {
            task.attempts++
            viewportRetryFrame.current = requestAnimationFrame(() => {
              viewportRetryFrame.current = 0
              drainViewportTasks()
            })
            return
          }
          failViewportTask(
            task,
            new Error('Canvas viewport was not ready after three attempts.')
          )
          return
        }
        pendingViewportTask.current = null
        const actualViewport = current.current.flow?.getViewport()
        if (actualViewport && state.current)
          state.current = setProjectionViewport(
            state.current,
            actualViewport,
            size()
          )
        const finalViewport = actualViewport ?? task.viewport
        if (task.commitUserViewport && finalViewport)
          persistUserViewport(task.token, finalViewport)
        settleViewportTask(task, true)
        drainViewportTasks()
      },
      (error: unknown) => {
        releaseIdle()
        viewportTaskIdle.current = null
        viewportTaskInFlight.current = false
        activeViewportTask.current = null
        failViewportTask(task, error)
      }
    )
  }
  function failViewportTask(task: ViewportTask, error: unknown) {
    const isCurrent = viewportTaskIsCurrent(task)
    if (pendingViewportTask.current === task) pendingViewportTask.current = null
    if (isCurrent) current.current.report(error)
    settleViewportTask(task, false)
    drainViewportTasks()
  }
  function requestViewportTask(
    origin: ViewportTask['origin'],
    kind: ViewportTask['kind'],
    viewport?: Viewport,
    options: {
      fitNodeIds?: string[]
      token?: CanvasViewportIntentToken
      commitUserViewport?: boolean
    } = {}
  ) {
    invalidatePendingViewportTask()
    const owner = current.current.owner
    const active = lifetime.current
    if (!active || owner !== active.owner || owner.getMode() === 'legacy')
      return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const task: ViewportTask = {
        id: viewportRequestId.current,
        owner,
        lifetime: active,
        activationEpoch: owner.getActivationEpoch(),
        repoPath: owner.repoPath,
        mode: owner.getMode() as 'view' | 'edit',
        modeRequestRevision: owner.getModeRequestRevision(),
        origin,
        kind,
        viewport,
        fitNodeIds: options.fitNodeIds,
        token: options.token,
        commitUserViewport: options.commitUserViewport ?? false,
        attempts: 0,
        measurementAttempts: 0,
        settled: false,
        resolve,
      }
      pendingViewportTask.current = task
      drainViewportTasks()
    })
  }
  function onFlowReady() {
    viewportReady.current = true
    drainViewportTasks()
  }
  function beginUserViewportIntent(event: Event) {
    return captureUserViewportInput(event)
  }
  function associateViewportEvent(event: Event) {
    associateUserViewportEvent(event)
  }
  function finishUserViewportIntent() {
    userViewportGesture.current = false
  }
  function getViewportOrigin(event: unknown): CanvasViewportEventOrigin {
    if (event && typeof event === 'object') {
      const token = viewportIntentByEvent.current.get(event as Event)
      if (token)
        return isViewportIntentCurrent(token)
          ? { origin: 'user', token }
          : { origin: 'stale', token }
    }
    if (activeViewportTask.current)
      return { origin: activeViewportTask.current.origin }
    if (viewportCommandOrigin.current !== null) return { origin: 'command' }
    return { origin: 'external' }
  }
  function beginViewportCommand(): CanvasViewportCommand {
    persistLastUserViewport()
    invalidatePendingViewportTask()
    userViewportGesture.current = false
    const id = ++viewportCommandId.current
    viewportCommandOrigin.current = id
    const owner = current.current.owner
    return {
      id,
      owner,
      repoPath: owner.repoPath,
      mode: owner.getMode(),
      modeRequestRevision: owner.getModeRequestRevision(),
      activationEpoch: owner.getActivationEpoch(),
      waitForViewport: viewportTaskIdle.current ?? Promise.resolve(),
    }
  }
  function isViewportCommandCurrent(command: CanvasViewportCommand) {
    return (
      viewportCommandOrigin.current === command.id &&
      command.owner === current.current.owner &&
      command.owner.isActive?.() !== false &&
      command.activationEpoch === command.owner.getActivationEpoch() &&
      command.repoPath === current.current.owner.repoPath &&
      command.mode === command.owner.getMode() &&
      command.modeRequestRevision === command.owner.getModeRequestRevision()
    )
  }
  async function persistViewportCommand(
    command: CanvasViewportCommand,
    viewport: Viewport
  ) {
    if (!isViewportCommandCurrent(command)) return false
    viewportCommandOrigin.current = null
    if (state.current)
      state.current = setProjectionViewport(state.current, viewport, size())
    if (command.mode !== 'legacy')
      writeCanvasModeViewport(command.repoPath, command.mode, viewport)
    else await ImageService.SetViewport(command.repoPath, viewport)
    return true
  }
  function cancelViewportCommand(command: CanvasViewportCommand) {
    if (viewportCommandOrigin.current === command.id)
      viewportCommandOrigin.current = null
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
    persistLastUserViewport()
    invalidatePendingViewportTask()
    viewportCommandOrigin.current = null
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
      await requestViewportTask('restore', 'set', viewport)
    })
  }
  function reconcile(
    board: AcceptedCanvasBoard,
    graph: Graph,
    history: UndoResult[]
  ) {
    const owner = current.current.owner
    const activeLifetime = lifetime.current
    const activationEpoch = owner.getActivationEpoch()
    if (
      activeLifetime?.owner === owner &&
      activeLifetime.activationEpoch !== activationEpoch
    ) {
      invalidatePendingViewportTask()
      activeLifetime.activationEpoch = activationEpoch
      state.current = null
      source.current = null
      nodesBeforePublication.current = null
      owner.setMode('legacy')
      setMode('legacy')
    }
    if (owner.isActive?.() === false) return false
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
      const owner = current.current.owner
      const needsInitialFit =
        !owner.getRepositoryViewport() &&
        readCanvasModeViewport(owner.repoPath, 'view') === null &&
        initial.viewNodes.length > 0
      void requestViewportTask(
        needsInitialFit ? 'initial-fit' : 'restore',
        needsInitialFit ? 'fit' : 'set',
        needsInitialFit ? undefined : initial.viewViewport,
        needsInitialFit
          ? { fitNodeIds: initial.viewNodes.map((node) => node.id) }
          : undefined
      )
      return true
    }
    const restoringViewport = pendingViewportTask.current !== null
    const before = restoringViewport ? state.current : capture(state.current)
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
    if (next.mode === 'view' && !restoringViewport)
      next = compensateAnchor(before, next)
    publish(next)
    if (
      !restoringViewport &&
      next.mode === 'view' &&
      !sameViewport(next.viewViewport, before.viewViewport)
    )
      void requestViewportTask('anchor', 'set', next.viewViewport)
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
    onFlowReady,
    beginUserViewportIntent,
    associateViewportEvent,
    finishUserViewportIntent,
    getViewportOrigin,
    beginViewportCommand,
    isViewportCommandCurrent,
    persistViewportCommand,
    cancelViewportCommand,
    setAnchor,
    reconcile,
    arrangeEdit,
  }
}

function getMeasuredFitViewport(
  flow: CanvasProjectionViewport,
  nodeIds: string[],
  viewportSize: { width: number; height: number }
) {
  if (!nodeIds.length || viewportSize.width <= 0 || viewportSize.height <= 0)
    return null
  if (!flow.getNode || !flow.getNodesBounds) return null
  const measured = nodeIds.every((id) => {
    const node = flow.getNode?.(id) as
      | (Node & { measured?: { width?: number; height?: number } })
      | undefined
    return (node?.measured?.width ?? 0) > 0 && (node?.measured?.height ?? 0) > 0
  })
  if (!measured) return null
  const bounds = flow.getNodesBounds(nodeIds)
  if (bounds.width <= 0 || bounds.height <= 0) return null
  return getViewportForBounds(
    bounds,
    viewportSize.width,
    viewportSize.height,
    0.05,
    1,
    0.2
  )
}

function sameViewport(a: Viewport, b: Viewport) {
  return (
    Math.abs(a.x - b.x) < 0.001 &&
    Math.abs(a.y - b.y) < 0.001 &&
    Math.abs(a.zoom - b.zoom) < 0.0001
  )
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
