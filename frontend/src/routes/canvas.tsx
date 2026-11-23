import {
  type Edge,
  type Node,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '@xyflow/react/dist/style.css'
import {
  type CanvasData,
  type ImageInfo,
  ImageService,
  type RepoInfo,
} from '../../bindings/loom/internal/service'
import { canvasCenter } from '../components/canvas/canvas-board-operations'
import { CanvasWorkspaceContent } from '../components/canvas/canvas-workspace-content'
import { useCanvasAssetOperations } from '../components/canvas/use-canvas-asset-operations'
import { useCanvasBoardModel } from '../components/canvas/use-canvas-board-model'
import { useCanvasRepository } from '../components/canvas/use-canvas-repository'
import { useCanvasWorkspaceState } from '../components/canvas/use-canvas-workspace-state'
import { useInspectorFieldSubmission } from '../components/canvas/use-inspector-field-submission'
import { emptySelection, type Selection } from '../lib/selection'
import { useUndoActions } from '../lib/use-undo'

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
  const [data, setData] = useState<CanvasData>({
    images: [],
    relationships: [],
    groups: [],
  })
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
  const dropTargets = useRef<Node[]>([])
  const [selection, setSelection] = useState<Selection>(emptySelection),
    [expanded, setExpanded] = useState<number | null>(null)
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
      flow,
      updateZoomCompensation,
      selection,
      refresh,
      setData,
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
    expanded,
    repoPath: repo.path,
    renditionGeneration,
    callbacks,
    selection,
    nodes,
    setNodes,
    edges,
    setEdges,
    target,
    dropTargets,
  })
  const { selectedIdsList } = boardModel
  const submitInspectorField = useInspectorFieldSubmission({
    repoPath: repo.path,
    selection,
    selectedIds: selectedIdsList,
    selectionRef,
    groupMembers,
    reload,
    fieldSubmissionPending,
    submissionScopeRef,
  })
  const canCreateSet = useMemo(
    () =>
      selection.surface === 'canvas' &&
      selection.group === null &&
      selection.ids.length >= 2 &&
      new Set(selection.ids).size === selection.ids.length &&
      selection.ids.every((id) => {
        const image = (data.images ?? []).find((item) => item.id === id)
        return image?.placed && !image.trashed && !image.groupId
      }),
    [selection.surface, selection.group, selection.ids, data.images]
  )
  const undoActions = useUndoActions(repo.path, reload)
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        void ImageService.LoadCanvas(repo.path)
          .then((result) => {
            if (result) setData(result)
            setRefresh((current) => current + 1)
          })
          .catch((error) => callbacks.current.report(error))
      },
      60 * 60 * 1000
    )
    return () => window.clearInterval(timer)
  }, [repo.path, setRefresh])
  const assetOperations = useCanvasAssetOperations({
    repoPath: repo.path,
    flow,
    selection,
    setSelection,
    selectedIds,
    reload,
    setExpanded,
    openAssets,
    selectAssets,
    setReveal,
    center,
    canCreateSet,
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
      dropTargets={dropTargets}
      workspaceState={workspaceState}
      repository={{ report, reload, reloadForData, run, assetSelectionKey }}
      assetOperations={assetOperations}
      selectAssets={selectAssets}
      groupMembers={groupMembers}
      selectedIds={selectedIds}
      boardModel={boardModel}
      submitInspectorField={submitInspectorField}
      canCreateSet={canCreateSet}
      undoActions={undoActions}
      assetSelectionRecords={assetSelectionRecords}
      updateZoomCompensation={updateZoomCompensation}
      submissionScopeRef={submissionScopeRef}
    />
  )
}
