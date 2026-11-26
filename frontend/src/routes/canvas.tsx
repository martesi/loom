import {
  type Edge,
  type Node,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import '@xyflow/react/dist/style.css'
import type {
  CanvasData,
  ImageInfo,
  RepoInfo,
} from '../../bindings/loom/internal/service'
import { canvasCenter } from '../components/canvas/canvas-board-operations'
import { useCanvasBoardOwner } from '../components/canvas/canvas-board-owner'
import { useCanvasSelectionAuthority } from '../components/canvas/canvas-selection-intent'
import { CanvasWorkspaceContent } from '../components/canvas/canvas-workspace-content'
import { useCanvasAssetOperations } from '../components/canvas/use-canvas-asset-operations'
import { useCanvasBoardModel } from '../components/canvas/use-canvas-board-model'
import { useCanvasRepository } from '../components/canvas/use-canvas-repository'
import { useCanvasWorkspaceState } from '../components/canvas/use-canvas-workspace-state'
import { useInspectorFieldSubmission } from '../components/canvas/use-inspector-field-submission'
import { useUndoActions } from '../lib/use-undo'

const emptyData: CanvasData = { images: [], relationships: [], groups: [] }

// Where a preview was opened from. Canvas opens keep the existing
// relationship-component carousel; folder opens step through that folder's
// images in ListDirectory order instead.
export function CanvasWorkspace({ repo }: { repo: RepoInfo }) {
  return (
    <ReactFlowProvider>
      <Canvas key={repo.path} repo={repo} />
    </ReactFlowProvider>
  )
}
function Canvas({ repo }: { repo: RepoInfo }) {
  const boardOwner = useCanvasBoardOwner(repo.path)
  const flow = useReactFlow(),
    host = useRef<HTMLDivElement>(null)
  const inverseZoom = useRef(1)
  const updateZoomCompensation = useCallback((zoom: number) => {
    const scale = Math.max(1, 1 / zoom)
    if (scale === inverseZoom.current) return
    inverseZoom.current = scale
    host.current
      ?.querySelectorAll<HTMLElement>(
        '.react-flow__node-image:hover [data-testid="image-node-metadata"], .react-flow__node-image:focus-within [data-testid="image-node-metadata"]'
      )
      .forEach((element) => {
        element.style.setProperty('--canvas-inverse-zoom', String(scale))
      })
  }, [])
  useEffect(() => {
    const root = host.current
    if (!root) return
    const syncActiveMetadata = (event: Event) => {
      if (!(event.target instanceof Element)) return
      const node = event.target.closest('.react-flow__node-image')
      const metadata = node?.querySelector<HTMLElement>(
        '[data-testid="image-node-metadata"]'
      )
      if (metadata)
        metadata.style.setProperty(
          '--canvas-inverse-zoom',
          String(inverseZoom.current)
        )
    }
    root.addEventListener('pointerover', syncActiveMetadata)
    root.addEventListener('focusin', syncActiveMetadata)
    return () => {
      root.removeEventListener('pointerover', syncActiveMetadata)
      root.removeEventListener('focusin', syncActiveMetadata)
    }
  }, [])
  const accepted = useSyncExternalStore(
    boardOwner.subscribe,
    boardOwner.getSnapshot
  )
  const data = accepted?.data ?? emptyData
  const [renditionGeneration, setRenditionGeneration] = useState(0)
  const invalidateMountedRenditions = useCallback(() => {
    setRenditionGeneration((current) => current + 1)
  }, [])
  const [nodes, setNodes] = useState<Node[]>([]),
    [edges, setEdges] = useState<Edge[]>([])
  const modifiedMarquee = useRef<{ active: boolean; anchor: number[] }>({
    active: false,
    anchor: [],
  })
  const [expanded, setExpanded] = useState<number | null>(null)
  const {
    selection,
    selectionRef,
    intentRef: selectionIntentRef,
    setSelection,
    setSelectionInternal,
    setSelectionFromOperation,
  } = useCanvasSelectionAuthority(repo.path)
  useEffect(() => {
    const liveIds = new Set((data.relationships ?? []).map((item) => item.id))
    const edges = selectionRef.current.edges.filter((id) => liveIds.has(id))
    if (edges.length !== selectionRef.current.edges.length)
      setSelectionInternal({ ...selectionRef.current, edges })
  }, [data.relationships, selectionRef, setSelectionInternal])
  const [assetSelectionRecords, setAssetSelectionRecords] = useState<{
    key: string
    records: ImageInfo[]
  }>({ key: '', records: [] })
  const workspaceState = useCanvasWorkspaceState(selection)
  const {
    refresh,
    setRefresh,
    setError,
    setReady,
    purgeIds,
    setPurgeIds,
    trashIds,
    setTrashIds,
    lifecyclePendingRef,
    setLifecyclePending,
    fieldSubmissionPending,
    pendingRecentAction,
    setRecentActionIds,
    openAssets,
    setReveal,
    target,
  } = workspaceState
  const { report, reload, reloadForData, run, assetSelectionKey } =
    useCanvasRepository({
      repoPath: repo.path,
      modeViewports: true,
      executor: boardOwner,
      flow,
      updateZoomCompensation,
      selection,
      selectionIntentRef,
      refresh,
      setRefresh,
      setError,
      setReady,
      setAssetSelectionRecords,
    })
  const selectAssets = useCallback(
    (ids: number[]) => {
      setExpanded(null)
      setSelection({ surface: 'assets', ids, edges: [], group: null })
    },
    [setSelection]
  )
  const groupMembers = useCallback(
    (id: number) => data.groups?.find((g) => g.id === id)?.memberIds ?? [],
    [data.groups]
  )
  const center = () => canvasCenter(flow, host)
  function selectedIds() {
    return selectionRef.current.ids
  }
  const callbacks = useRef({ report, run, selectAssets })
  callbacks.current = { report, run, selectAssets }
  const boardModel = useCanvasBoardModel({
    data,
    startInView: true,
    owner: boardOwner,
    renditionGeneration,
    callbacks,
    selection,
    setSelection,
    setSelectionInternal,
    nodes,
    setNodes,
    edges,
    setEdges,
    target,
    host,
    flow,
    cancelPointerGesture: () => {
      workspaceState.relation.current = null
      workspaceState.setRelationshipPreview(null)
      workspaceState.updateTarget(null)
      modifiedMarquee.current.active = false
    },
  })
  const submitInspectorField = useInspectorFieldSubmission({
    repoPath: repo.path,
    selectionRef,
    groupMembers,
    reload,
    submissionScopeRef: selectionIntentRef,
    fieldSubmissionPending,
  })
  const undoActions = useUndoActions(
    repo.path,
    boardOwner.applyHistory,
    boardOwner
  )
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        void reload().catch((error) => callbacks.current.report(error))
      },
      60 * 60 * 1000
    )
    return () => window.clearInterval(timer)
  }, [reload])
  const assetOperations = useCanvasAssetOperations({
    repoPath: repo.path,
    owner: boardOwner,
    flow,
    host,
    beginViewportCommand: boardModel.beginViewportCommand,
    isViewportCommandCurrent: boardModel.isViewportCommandCurrent,
    persistViewportCommand: boardModel.persistViewportCommand,
    cancelViewportCommand: boardModel.cancelViewportCommand,
    setSelection,
    setSelectionFromOperation,
    selectionRef,
    selectionIntentRef,
    selectedIds,
    setExpanded,
    openAssets,
    selectAssets,
    setReveal,
    center,
    purgeIds,
    trashIds,
    setPurgeIds,
    setTrashIds,
    lifecyclePendingRef,
    setLifecyclePending,
    pendingRecentAction,
    setRecentActionIds,
    setError,
  })
  return (
    <CanvasWorkspaceContent
      repo={repo}
      flow={flow}
      host={host}
      data={data}
      renditionGeneration={renditionGeneration}
      onRenditionsInvalidated={invalidateMountedRenditions}
      nodes={nodes}
      setNodes={setNodes}
      edges={edges}
      setEdges={setEdges}
      selection={selection}
      setSelection={setSelection}
      setSelectionFromOperation={setSelectionFromOperation}
      selectionRef={selectionRef}
      expanded={expanded}
      setExpanded={setExpanded}
      modifiedMarquee={modifiedMarquee}
      workspaceState={workspaceState}
      repository={{ report, reload, reloadForData, run, assetSelectionKey }}
      assetOperations={assetOperations}
      selectAssets={selectAssets}
      groupMembers={groupMembers}
      selectedIds={selectedIds}
      boardModel={boardModel}
      submitInspectorField={submitInspectorField}
      undoActions={undoActions}
      assetSelectionRecords={assetSelectionRecords}
      updateZoomCompensation={updateZoomCompensation}
      selectionIntentRef={selectionIntentRef}
    />
  )
}
