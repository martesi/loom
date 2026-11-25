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
import { CanvasWorkspaceContent } from '../components/canvas/canvas-workspace-content'
import { useCanvasAssetOperations } from '../components/canvas/use-canvas-asset-operations'
import { useCanvasBoardModel } from '../components/canvas/use-canvas-board-model'
import { useCanvasRepository } from '../components/canvas/use-canvas-repository'
import { useCanvasWorkspaceState } from '../components/canvas/use-canvas-workspace-state'
import { useInspectorFieldSubmission } from '../components/canvas/use-inspector-field-submission'
import { emptySelection, type Selection } from '../lib/selection'
import { useUndoActions } from '../lib/use-undo'

const emptyData: CanvasData = { images: [], relationships: [], groups: [] }

// Where a preview was opened from. Canvas opens keep the existing
// relationship-component carousel; folder opens step through that folder's
// images in ListDirectory order instead.
export function CanvasWorkspace({ repo }: { repo: RepoInfo }) {
  return (
    <ReactFlowProvider>
      <Canvas repo={repo} />
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
  const [storedSelection, setSelection] = useState<Selection>(emptySelection),
    [expanded, setExpanded] = useState<number | null>(null)
  const liveRelationshipIds = new Set(
    (data.relationships ?? []).map((item) => item.id)
  )
  const liveEdges = storedSelection.edges.filter((id) =>
    liveRelationshipIds.has(id)
  )
  const selection =
    liveEdges.length === storedSelection.edges.length
      ? storedSelection
      : { ...storedSelection, edges: liveEdges }
  useEffect(() => {
    setSelection((current) => {
      const liveIds = new Set((data.relationships ?? []).map((item) => item.id))
      const edges = current.edges.filter((id) => liveIds.has(id))
      return edges.length === current.edges.length
        ? current
        : { ...current, edges }
    })
  }, [data.relationships])
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const submissionScope = `${repo.path}\u0000${selection.surface}\u0000${selection.ids
    .slice()
    .sort((a, b) => a - b)
    .join(',')}\u0000${selection.group ?? ''}`
  const submissionScopeRef = useRef({ key: submissionScope, revision: 0 })
  if (submissionScopeRef.current.key !== submissionScope) {
    submissionScopeRef.current = {
      key: submissionScope,
      revision: submissionScopeRef.current.revision + 1,
    }
  }
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
      executor: boardOwner,
      flow,
      updateZoomCompensation,
      selection,
      refresh,
      setRefresh,
      setError,
      setReady,
      setAssetSelectionRecords,
    })
  const selectAssets = useCallback((ids: number[]) => {
    setExpanded(null)
    setSelection({ surface: 'assets', ids, edges: [], group: null })
  }, [])
  const groupMembers = useCallback(
    (id: number) => data.groups?.find((g) => g.id === id)?.memberIds ?? [],
    [data.groups]
  )
  const center = () => canvasCenter(flow, host)
  function selectedIds() {
    return selectedIdsList
  }
  const callbacks = useRef({ report, run, selectAssets })
  callbacks.current = { report, run, selectAssets }
  const boardModel = useCanvasBoardModel({
    data,
    owner: boardOwner,
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
    cancelPointerGesture: () => {
      workspaceState.relation.current = null
      workspaceState.setRelationshipPreview(null)
      workspaceState.updateTarget(null)
      modifiedMarquee.current.active = false
    },
  })
  const { selectedIdsList } = boardModel
  const submitInspectorField = useInspectorFieldSubmission({
    owner: boardOwner,
    repoPath: repo.path,
    selection,
    selectedIds: selectedIdsList,
    selectionRef,
    groupMembers,
    fieldSubmissionPending,
    submissionScopeRef,
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
    selection,
    setSelection,
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
      submissionScopeRef={submissionScopeRef}
    />
  )
}
