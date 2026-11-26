import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import type { Edge, Node, ReactFlowInstance } from '@xyflow/react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useEffect } from 'react'
import type {
  CanvasData,
  ImageInfo,
  RepoInfo,
} from '../../../bindings/loom/internal/service'
import { filesToMedia } from '../../lib/clipboard'
import type { Selection } from '../../lib/selection'
import type { useUndoActions } from '../../lib/use-undo'
import {
  alignCanvas,
  arrangeCanvas,
  fitCanvas,
  isCanvasRelationshipDrag as isRelationshipDrag,
  resetCanvasZoom,
  targetAt,
  validateRelationshipTarget,
  zoomCanvas,
} from './canvas-board-operations'
import { CanvasMainSurface } from './canvas-main-surface'
import { CanvasOverlays } from './canvas-overlays'
import type { CanvasSelectionIntentRef } from './canvas-selection-intent'
import { CanvasToolbar } from './canvas-toolbar'
import { DetailPanel } from './detail-panel'
import { ImageNode } from './image-node'
import { LibraryPanel } from './library-panel'
import { ShelfPanel } from './shelf-panel'
import type { useCanvasAssetOperations } from './use-canvas-asset-operations'
import type { useCanvasBoardModel } from './use-canvas-board-model'
import type { useCanvasRepository } from './use-canvas-repository'
import { useCanvasWorkspaceCommands } from './use-canvas-workspace-commands'
import type { useCanvasWorkspaceState } from './use-canvas-workspace-state'
import type { useInspectorFieldSubmission } from './use-inspector-field-submission'

const nodeTypes = { image: ImageNode }

interface Props {
  repo: RepoInfo
  flow: ReactFlowInstance
  host: MutableRefObject<HTMLDivElement | null>
  data: CanvasData
  renditionGeneration: number
  onRenditionsInvalidated: () => void
  nodes: Node[]
  setNodes: Dispatch<SetStateAction<Node[]>>
  edges: Edge[]
  setEdges: Dispatch<SetStateAction<Edge[]>>
  selection: Selection
  setSelection: Dispatch<SetStateAction<Selection>>
  selectionRef: MutableRefObject<Selection>
  expanded: number | null
  setExpanded: Dispatch<SetStateAction<number | null>>
  modifiedMarquee: MutableRefObject<{ active: boolean; anchor: number[] }>
  workspaceState: ReturnType<typeof useCanvasWorkspaceState>
  repository: ReturnType<typeof useCanvasRepository>
  assetOperations: ReturnType<typeof useCanvasAssetOperations>
  selectAssets: (ids: number[]) => void
  groupMembers: (id: number) => number[]
  selectedIds: () => number[]
  boardModel: ReturnType<typeof useCanvasBoardModel>
  submitInspectorField: ReturnType<typeof useInspectorFieldSubmission>
  undoActions: ReturnType<typeof useUndoActions>
  assetSelectionRecords: { key: string; records: ImageInfo[] }
  updateZoomCompensation: (zoom: number) => void
  selectionIntentRef: CanvasSelectionIntentRef
}

export function CanvasWorkspaceContent(props: Props) {
  const {
    repo,
    flow,
    host,
    data,
    renditionGeneration,
    onRenditionsInvalidated,
    nodes,
    setNodes,
    edges,
    setEdges,
    selection,
    setSelection,
    selectionRef,
    expanded,
    setExpanded,
    modifiedMarquee,
    workspaceState,
    repository,
    assetOperations,
    selectAssets,
    groupMembers,
    selectedIds,
    boardModel,
    submitInspectorField,
    undoActions,
    assetSelectionRecords,
    updateZoomCompensation,
    selectionIntentRef,
  } = props
  const { report, reload, run, assetSelectionKey } = repository
  const {
    compressIds,
    setCompressIds,
    purgeIds,
    setPurgeIds,
    trashIds,
    setTrashIds,
    lifecyclePending,
    setLifecyclePending,
    lifecyclePendingRef,
    pendingRecentAction,
    previewImageId,
    setPreviewImageId,
    previewInfoOpen,
    setPreviewInfoOpen,
    assetsOpen,
    inspectorOpen,
    assetsPinned,
    inspectorPinned,
    focusCanvas,
    setFocusCanvas,
    paletteOpen,
    perfHud,
    setPerfHud,
    settingsSection,
    setSettingsSection,
    shortcutsOnly,
    paletteInitialQuery,
    recentActionIds,
    inspectorCommandRequest,
    repoMenuOpen,
    setRepoMenuOpen,
    repoMenuRef,
    searchFocusRequest,
    repoOpenRequest,
    navigatorModeRequest,
    paletteAssets,
    paletteAssetsLoading,
    paletteAssetsError,
    setPaletteAssetRequest,
    importInput,
    openAssets,
    closeAssets,
    closeInspector,
    handleInspectorCommandRequest,
    openPalette,
    changePaletteOpen,
    menu,
    setMenu,
    reveal,
    setReveal,
    relation,
    connectionTool,
    setConnectionTool,
    connectionAnchorId,
    setConnectionAnchorId,
    pendingDragNode,
    dragTargetRaf,
    zoomRaf,
    pendingZoom,
    relationshipPreview,
    setRelationshipPreview,
    target,
    updateTarget,
    refresh,
    error,
    space,
    ready,
    setError,
  } = workspaceState
  const {
    isCanvasNodeSelected,
    displayNodes,
    displayEdges,
    selectedCanvasNodeIds,
    setHoveredNodeId,
  } = boardModel
  const {
    paste,
    importMedia,
    captureIntent,
    isCurrentIntent,
    finishTrash,
    confirmPurge,
  } = assetOperations

  useEffect(() => {
    if (
      !connectionTool ||
      (boardModel.mode === 'edit' &&
        (connectionTool === 'reverse-relationship' ||
          (connectionAnchorId !== null &&
            data.images?.some(
              (image) =>
                image.id === connectionAnchorId &&
                !image.trashed &&
                !image.missing
            ))))
    )
      return
    setConnectionTool(null)
    setConnectionAnchorId(null)
  }, [
    boardModel.mode,
    connectionAnchorId,
    connectionTool,
    data.images,
    setConnectionAnchorId,
    setConnectionTool,
  ])

  const validTarget = (
    source: number,
    id: string,
    excludedRelationshipId?: number
  ) =>
    validateRelationshipTarget(
      source,
      id,
      data,
      groupMembers,
      excludedRelationshipId
    )
  const arrange = (nodeIds?: string[]) =>
    boardModel.owner.getMode() === 'edit'
      ? boardModel.arrangeEdit(nodeIds)
      : boardModel.owner.getMode() === 'legacy'
        ? arrangeCanvas(repo.path, nodes, edges, data, reload, nodeIds)
        : Promise.resolve()
  const alignHorizontal = () =>
    alignCanvas('horizontal', repo.path, displayNodes, data, reload)
  const alignVertical = () =>
    alignCanvas('vertical', repo.path, displayNodes, data, reload)
  function handleLocate(node: Node) {
    setMenu(null)
    openAssets()
    const imageId = Number(node.id)
    selectAssets([imageId])
    setReveal({ id: imageId, folder: null })
    const live = boardModel.mode === 'legacy' ? node : flow.getNode(node.id)
    if (!live) return
    void flow
      .setCenter(
        live.position.x + (live.measured?.width ?? live.width ?? 150) / 2,
        live.position.y + (live.measured?.height ?? live.height ?? 110) / 2,
        { zoom: flow.getZoom() }
      )
      .catch(report)
  }
  function handlePreview(node: Node) {
    workspaceState.setPreviewOrigin({ surface: 'canvas' })
    workspaceState.setPreviewFolderOrder(null)
    setPreviewImageId(Number(node.id))
  }
  function handleFolderPreview(
    imageId: number,
    folder: string,
    orderedIds: number[]
  ) {
    workspaceState.setPreviewOrigin({ surface: 'folder', folder })
    workspaceState.setPreviewFolderOrder(orderedIds)
    setPreviewImageId(imageId)
  }
  const persistViewport = boardModel.mode === 'legacy'
  const fitAll = () => fitCanvas(flow, repo.path, undefined, persistViewport)
  const fitSelection = () =>
    fitCanvas(
      flow,
      repo.path,
      nodes.filter(isCanvasNodeSelected),
      persistViewport
    )
  const resetZoom = () =>
    resetCanvasZoom(flow, host, repo.path, persistViewport)
  const zoomBy = (factor: number) =>
    zoomCanvas(flow, repo.path, factor, persistViewport)
  function toggleFocusMode() {
    setFocusCanvas((focused) => !focused)
    requestAnimationFrame(() => host.current?.focus())
  }
  const workspaceCommands = useCanvasWorkspaceCommands({
    repo,
    host,
    data,
    selection,
    workspaceState,
    boardModel,
    assetOperations,
    report,
    reload,
    assetSelectionKey,
    assetSelectionRecords,
    view: {
      fitAll,
      fitSelection,
      resetZoom,
      zoomBy,
      arrange,
      alignHorizontal,
      alignVertical,
      toggleFocusMode,
    },
    selectionActions: {
      selectAssets,
      setSelection,
      setExpanded,
      expanded,
      selectedIds,
      handlePreview,
      handleLocate,
      undoActions,
    },
  })
  const {
    actionCatalog,
    defaultShortcuts,
    actionById,
    executeActionById,
    runDockAction,
    setAssetsOpenAction,
    setAssetsPinnedAction,
    setInspectorOpenAction,
    setInspectorPinnedAction,
    markAssetsVisible,
    compressAssets,
    showCommandsAction,
    goDetail,
    runPaletteAction,
    choosePaletteAsset,
    menuItems,
    preview,
  } = workspaceCommands
  const {
    images: previewImages,
    index: previewIndex,
    relatedImages,
    jumpTo: handlePreviewJump,
    close: closePreview,
  } = preview
  const mutationFence = boardModel.owner.getMutationFence()
  return (
    <div className="relative h-screen overflow-hidden bg-surface-canvas text-ink">
      {error && (
        <div
          role="alert"
          className="absolute left-1/2 top-16 z-40 flex max-w-[min(620px,calc(100vw-24px))] -translate-x-1/2 items-center gap-3 rounded-md border border-danger/30 bg-card px-3 py-2 text-sm shadow-lg"
        >
          {error}
          <button type="button" onClick={() => setError('')}>
            <Trans>Dismiss</Trans>
          </button>
        </div>
      )}
      {mutationFence && (
        <div
          role="alert"
          data-testid="canvas-mutation-fence"
          className="absolute left-1/2 top-28 z-40 flex max-w-[min(680px,calc(100vw-24px))] -translate-x-1/2 items-center gap-3 rounded-md border border-danger/30 bg-card px-3 py-2 text-sm shadow-lg"
        >
          <span>
            {mutationFence.uncertain
              ? 'Canvas write outcome is unknown. Editing remains blocked. Do not repeat the write; only an authoritative operation-status check can clear this block.'
              : 'Canvas edits are paused until the latest repository state is reconciled.'}
          </span>
          {!mutationFence.uncertain && (
            <button
              type="button"
              onClick={() => {
                void boardModel.owner
                  .retryReconciliation()
                  .then((reconciled) => {
                    if (!reconciled)
                      setError(
                        'Canvas reconciliation is still pending. The repository state remains fenced.'
                      )
                  })
                  .catch(report)
              }}
              className="rounded px-2 py-1 text-ink-muted hover:bg-accent hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Retry reconciliation
            </button>
          )}
        </div>
      )}
      <div className="absolute inset-0">
        <ShelfPanel
          title={t`Assets`}
          side="left"
          open={assetsOpen}
          onOpenChange={setAssetsOpenAction}
          pinned={assetsPinned}
          onPinnedChange={setAssetsPinnedAction}
          focusHidden={focusCanvas}
          shortcutHint={actionById.get('toggle-assets')?.shortcut}
        >
          <LibraryPanel
            key={repo.path}
            path={repo.path}
            selection={selection}
            select={selectAssets}
            refresh={refresh}
            renditionGeneration={renditionGeneration}
            onError={report}
            visible={markAssetsVisible}
            reveal={reveal}
            change={reload}
            compress={compressAssets}
            searchFocusRequest={searchFocusRequest}
            navigatorModeRequest={navigatorModeRequest}
            onShowCommands={showCommandsAction}
            onPreview={handleFolderPreview}
          />
        </ShelfPanel>
        <CanvasMainSurface
          updateProjectionViewport={boardModel.updateProjectionViewport}
          repoPath={repo.path}
          owner={boardModel.owner}
          mode={boardModel.mode}
          connectionTool={connectionTool}
          setConnectionTool={setConnectionTool}
          connectionAnchorId={connectionAnchorId}
          setConnectionAnchorId={setConnectionAnchorId}
          transitionMode={boardModel.transitionMode}
          flow={flow}
          data={data}
          setNodes={setNodes}
          setEdges={setEdges}
          setSelection={setSelection}
          selectionRef={selectionRef}
          selectionIntentRef={selectionIntentRef}
          setExpanded={setExpanded}
          space={space}
          ready={ready}
          inspectorOpen={inspectorOpen}
          inspectorPinned={inspectorPinned}
          focusCanvas={focusCanvas}
          closeInspector={closeInspector}
          host={host}
          modifiedMarquee={modifiedMarquee}
          nodeTypes={nodeTypes}
          displayNodes={displayNodes}
          displayEdges={displayEdges}
          isCanvasNodeSelected={isCanvasNodeSelected}
          selectedCanvasNodeIds={selectedCanvasNodeIds}
          targetAt={targetAt}
          isRelationshipDrag={isRelationshipDrag}
          validTarget={validTarget}
          relation={relation}
          relationshipPreview={relationshipPreview}
          setRelationshipPreview={setRelationshipPreview}
          updateTarget={updateTarget}
          target={target}
          run={run}
          paste={paste}
          captureAssetIntent={captureIntent}
          isAssetIntentCurrent={isCurrentIntent}
          dragTargetRaf={dragTargetRaf}
          pendingDragNode={pendingDragNode}
          report={report}
          setError={setError}
          assetsPinned={assetsPinned}
          closeAssets={closeAssets}
          updateZoomCompensation={updateZoomCompensation}
          zoomRaf={zoomRaf}
          pendingZoom={pendingZoom}
          menu={menu}
          menuItems={menuItems}
          setMenu={setMenu}
          setHoveredNodeId={setHoveredNodeId}
          handlePreview={handlePreview}
          actionById={actionById}
          runDockAction={runDockAction}
          perfHud={perfHud}
          setPerfHud={setPerfHud}
        />
        <ShelfPanel
          title={t`Inspector`}
          deferOpeningFocus={inspectorCommandRequest?.pending ?? false}
          side="right"
          open={inspectorOpen}
          onOpenChange={setInspectorOpenAction}
          pinned={inspectorPinned}
          onPinnedChange={setInspectorPinnedAction}
          focusHidden={focusCanvas}
          shortcutHint={actionById.get('toggle-inspector')?.shortcut}
        >
          <DetailPanel
            open={inspectorOpen}
            path={repo.path}
            data={data}
            graphOrder={
              boardModel.mode === 'legacy' ? undefined : boardModel.graphOrder
            }
            selection={selection}
            change={reload}
            go={goDetail}
            onError={report}
            commandRequest={inspectorCommandRequest}
            onCommandRequestHandled={handleInspectorCommandRequest}
            onAction={runDockAction}
            onSubmitField={submitInspectorField}
            selectionRevision={selectionIntentRef.current.revision}
            restoreEnabled={
              actionById.get('restore-from-trash')?.enabled ?? false
            }
            canMutateRelationships={() =>
              boardModel.owner.allows('relationship')
            }
          />
        </ShelfPanel>
      </div>
      <CanvasToolbar
        repo={repo}
        repoOpenRequest={repoOpenRequest}
        focusCanvas={focusCanvas}
        assetsOpen={assetsOpen}
        inspectorOpen={inspectorOpen}
        repoMenuOpen={repoMenuOpen}
        setRepoMenuOpen={setRepoMenuOpen}
        repoMenuRef={repoMenuRef}
        importInput={importInput}
        actionShortcut={(id) => actionById.get(id)?.shortcut}
        openPalette={openPalette}
        executeActionById={executeActionById}
        toggleFocusMode={toggleFocusMode}
        onImportFiles={(files) => {
          const intent = captureIntent()
          void filesToMedia(files)
            .then((media) =>
              isCurrentIntent(intent) ? importMedia(media, intent) : undefined
            )
            .catch(report)
        }}
        mode={boardModel.mode}
        unpairedCount={countUnpaired(data)}
        onModeChange={(mode) => {
          setConnectionTool(null)
          setConnectionAnchorId(null)
          void boardModel.transitionMode(mode).catch(report)
        }}
      />
      <CanvasOverlays
        repoPath={repo.path}
        actionCatalog={actionCatalog}
        defaultShortcuts={defaultShortcuts}
        paletteOpen={paletteOpen}
        shortcutsOnly={shortcutsOnly}
        paletteInitialQuery={paletteInitialQuery}
        recentActionIds={recentActionIds}
        paletteAssets={paletteAssets}
        paletteAssetsLoading={paletteAssetsLoading}
        paletteAssetsError={paletteAssetsError}
        retryPaletteAssets={() =>
          setPaletteAssetRequest((request) => request + 1)
        }
        changePaletteOpen={changePaletteOpen}
        runPaletteAction={runPaletteAction}
        choosePaletteAsset={choosePaletteAsset}
        settingsSection={settingsSection}
        closeSettings={() => setSettingsSection(null)}
        previewImageId={previewImageId}
        previewIndex={previewIndex}
        previewImages={previewImages}
        closePreview={closePreview}
        setPreviewImageId={setPreviewImageId}
        relatedImages={relatedImages}
        onPreviewJump={handlePreviewJump}
        previewInfoOpen={previewInfoOpen}
        setPreviewInfoOpen={setPreviewInfoOpen}
        data={data}
        canvasImageIds={
          boardModel.mode === 'legacy'
            ? undefined
            : displayNodes.map((node) => Number(node.id))
        }
        renditionGeneration={renditionGeneration}
        onRenditionsInvalidated={onRenditionsInvalidated}
        compressIds={compressIds}
        setCompressIds={setCompressIds}
        reload={reload}
        purgeIds={purgeIds}
        trashIds={trashIds}
        lifecyclePending={lifecyclePending}
        pendingRecentAction={pendingRecentAction}
        lifecyclePendingRef={lifecyclePendingRef}
        setPurgeIds={setPurgeIds}
        setTrashIds={setTrashIds}
        setLifecyclePending={setLifecyclePending}
        confirmPurge={confirmPurge}
        finishTrash={finishTrash}
        report={report}
      />
    </div>
  )
}

function countUnpaired(data: CanvasData) {
  const paired = new Set(
    (data.relationships ?? []).flatMap((relationship) => [
      relationship.sourceImageId,
      relationship.derivedImageId,
    ])
  )
  return (data.images ?? []).filter(
    (image) => !image.trashed && !paired.has(image.id)
  ).length
}
