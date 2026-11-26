import { t } from '@lingui/core/macro'
import type {
  Edge,
  Node,
  NodeTypes,
  ReactFlowInstance,
  Viewport,
  XYPosition,
} from '@xyflow/react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { CanvasData } from '../../../bindings/loom/internal/service'
import { ImageService } from '../../../bindings/loom/internal/service'
import type { CanvasAction } from '../../lib/action-catalog'
import type { readMedia } from '../../lib/clipboard'
import type { Selection } from '../../lib/selection'
import { type MenuAction, PositionedMenu } from '../menu'
import type { CanvasBoardOwner } from './canvas-board-owner'
import { CanvasConnectionToolStatus } from './canvas-connection-tool-status'
import { CanvasDock } from './canvas-dock'
import { CanvasFlow } from './canvas-flow'
import type { CanvasInternalMode } from './canvas-mode-policy'
import { PerfHud } from './perf-hud'
import type { CanvasAssetIntent } from './use-canvas-asset-operations'
import { useCanvasConnectionTool } from './use-canvas-connection-tool'
import { useCanvasDropHandlers } from './use-canvas-drop-handlers'
import type { CanvasConnectionTool } from './use-canvas-workspace-state'

interface MenuState {
  kind: 'pane' | 'node' | 'selection' | 'edge'
  x: number
  y: number
  nodeId?: string
  keyboard?: boolean
}

interface RelationshipPreview {
  x1: number
  y1: number
  x2: number
  y2: number
  valid: boolean | null
}

interface DropTarget {
  id: string
  valid: boolean
  kind: 'relationship'
  reason?: string
}

interface Props {
  repoPath: string
  owner: CanvasBoardOwner
  mode: CanvasInternalMode
  connectionTool: CanvasConnectionTool
  setConnectionTool: Dispatch<SetStateAction<CanvasConnectionTool>>
  connectionAnchorId: number | null
  setConnectionAnchorId: Dispatch<SetStateAction<number | null>>
  transitionMode: (mode: 'view' | 'edit') => Promise<void>
  flow: ReactFlowInstance
  data: CanvasData
  setNodes: Dispatch<SetStateAction<Node[]>>
  setEdges: Dispatch<SetStateAction<Edge[]>>
  setSelection: Dispatch<SetStateAction<Selection>>
  selectionRef: MutableRefObject<Selection>
  setExpanded: Dispatch<SetStateAction<number | null>>
  space: boolean
  ready: boolean
  inspectorOpen: boolean
  inspectorPinned: boolean
  focusCanvas: boolean
  closeInspector: (restoreFocus?: boolean) => void
  host: MutableRefObject<HTMLDivElement | null>
  modifiedMarquee: MutableRefObject<{ active: boolean; anchor: number[] }>
  nodeTypes: NodeTypes
  displayNodes: Node[]
  displayEdges: Edge[]
  isCanvasNodeSelected: (node: Node) => boolean
  selectedCanvasNodeIds: string[]
  targetAt: (x: number, y: number) => string | null
  isRelationshipDrag: (
    drag: { x: number; y: number },
    x: number,
    y: number
  ) => boolean
  validTarget: (
    source: number,
    id: string,
    excludedRelationshipId?: number
  ) => { valid: boolean; reason?: string }
  relation: MutableRefObject<{ source: number; x: number; y: number } | null>
  relationshipPreview: RelationshipPreview | null
  setRelationshipPreview: Dispatch<SetStateAction<RelationshipPreview | null>>
  updateTarget: (target: DropTarget | null) => void
  target: DropTarget | null
  run: (action: () => Promise<unknown>, guard?: () => boolean) => void
  paste: (
    media?: Awaited<ReturnType<typeof readMedia>>,
    surface?: Selection['surface'],
    dropPosition?: XYPosition,
    intent?: CanvasAssetIntent
  ) => Promise<void>
  captureAssetIntent: () => CanvasAssetIntent
  isAssetIntentCurrent: (intent: CanvasAssetIntent) => boolean
  dragTargetRaf: MutableRefObject<number>
  pendingDragNode: MutableRefObject<Node | null>
  reloadForData: () => Promise<CanvasData | null>
  report: (error: unknown) => void
  setError: Dispatch<SetStateAction<string>>
  assetsPinned: boolean
  closeAssets: (restoreFocus?: boolean) => void
  updateZoomCompensation: (zoom: number) => void
  updateProjectionViewport: (viewport: Viewport) => void
  zoomRaf: MutableRefObject<number>
  pendingZoom: MutableRefObject<number>
  menu: MenuState | null
  menuItems: MenuAction[]
  setMenu: Dispatch<SetStateAction<MenuState | null>>
  setHoveredNodeId: Dispatch<SetStateAction<string | null>>
  handlePreview: (node: Node) => void
  actionById: ReadonlyMap<string, CanvasAction>
  runDockAction: (id: string) => void
  perfHud: boolean
  setPerfHud: Dispatch<SetStateAction<boolean>>
}

export function CanvasMainSurface(props: Props) {
  const {
    repoPath,
    owner,
    mode,
    connectionTool,
    setConnectionTool,
    connectionAnchorId,
    setConnectionAnchorId,
    transitionMode,
    flow,
    data,
    setNodes,
    setEdges,
    setSelection,
    selectionRef,
    setExpanded,
    space,
    ready,
    inspectorOpen,
    inspectorPinned,
    focusCanvas,
    closeInspector,
    host,
    modifiedMarquee,
    nodeTypes,
    displayNodes,
    displayEdges,
    isCanvasNodeSelected,
    selectedCanvasNodeIds,
    targetAt,
    isRelationshipDrag,
    validTarget,
    relation,
    relationshipPreview,
    setRelationshipPreview,
    updateTarget,
    target,
    run,
    paste,
    captureAssetIntent,
    isAssetIntentCurrent,
    dragTargetRaf,
    pendingDragNode,
    reloadForData,
    report,
    setError,
    assetsPinned,
    closeAssets,
    updateZoomCompensation,
    updateProjectionViewport,
    zoomRaf,
    pendingZoom,
    menu,
    menuItems,
    setMenu,
    setHoveredNodeId,
    handlePreview,
    actionById,
    runDockAction,
    perfHud,
    setPerfHud,
  } = props
  const connectionEvents = useCanvasConnectionTool({
    tool: connectionTool,
    anchorId: connectionAnchorId,
    mode,
    owner,
    repoPath,
    data,
    host,
    targetAt,
    validTarget,
    run,
    setError,
    setPreview: setRelationshipPreview,
    updateTarget,
  })
  const dropHandlers = useCanvasDropHandlers({
    repoPath,
    owner,
    flow,
    paste,
    captureIntent: captureAssetIntent,
    isCurrentIntent: isAssetIntentCurrent,
    reloadForData,
    report,
    assetsPinned,
    closeAssets,
    host,
    setSelection,
  })
  const selectedIds = selectionRef.current.ids
  const canStartConnection =
    selectionRef.current.surface === 'canvas' &&
    selectedIds.length === 1 &&
    data.images?.some(
      (image) => image.id === selectedIds[0] && !image.missing && !image.trashed
    ) === true
  return (
    <main
      ref={host}
      data-canvas-surface
      aria-label={t`Canvas`}
      tabIndex={-1}
      className="absolute inset-0 min-w-0 outline-none"
      onClickCapture={(event) => {
        if (connectionEvents.onClickCapture(event)) return
        if (
          owner.allows('relationship') &&
          (event.ctrlKey || event.metaKey) &&
          targetAt(event.clientX, event.clientY)
        ) {
          event.stopPropagation()
          event.preventDefault()
        }
      }}
      onPointerDownCapture={(event) => {
        if (connectionEvents.onPointerDownCapture(event)) return
        if (!owner.allows('relationship')) return
        const id = targetAt(event.clientX, event.clientY)
        if ((event.ctrlKey || event.metaKey) && id) {
          relation.current = {
            source: Number(id),
            x: event.clientX,
            y: event.clientY,
          }
          event.stopPropagation()
          event.preventDefault()
        }
      }}
      onPointerCancel={() => {
        connectionEvents.onPointerCancel()
        relation.current = null
        setRelationshipPreview(null)
        updateTarget(null)
      }}
      onPointerMove={(event) => {
        if (connectionEvents.onPointerMove(event)) return
        const drag = relation.current
        if (!drag) return
        if (!isRelationshipDrag(drag, event.clientX, event.clientY)) {
          setRelationshipPreview(null)
          updateTarget(null)
          return
        }
        const id = targetAt(event.clientX, event.clientY)
        const result = id ? validTarget(drag.source, id) : null
        const rect = host.current?.getBoundingClientRect()
        if (rect)
          setRelationshipPreview({
            x1: drag.x - rect.left,
            y1: drag.y - rect.top,
            x2: event.clientX - rect.left,
            y2: event.clientY - rect.top,
            valid: result?.valid ?? null,
          })
        updateTarget(
          id
            ? {
                id,
                valid: result?.valid ?? false,
                reason: result?.reason,
                kind: 'relationship',
              }
            : null
        )
      }}
      onPointerUpCapture={(event) => {
        if (connectionEvents.onPointerUpCapture(event)) return
        const drag = relation.current
        if (!drag) return
        event.stopPropagation()
        event.preventDefault()
        relation.current = null
        setRelationshipPreview(null)
        updateTarget(null)
        if (!owner.allows('relationship')) return
        const id = targetAt(event.clientX, event.clientY)
        if (!isRelationshipDrag(drag, event.clientX, event.clientY)) {
          setSelection((current) => ({
            surface: 'canvas',
            ids: current.ids.includes(drag.source)
              ? current.ids.filter((imageId) => imageId !== drag.source)
              : [
                  ...(current.surface === 'canvas' ? current.ids : []),
                  drag.source,
                ],
            edges: [],
            group: null,
          }))
          return
        }
        setSelection({
          surface: 'canvas',
          ids: [drag.source],
          edges: [],
          group: null,
        })
        if (id && validTarget(drag.source, id).valid)
          run(() =>
            owner.allows('relationship')
              ? ImageService.LinkSource(repoPath, drag.source, Number(id))
              : Promise.resolve()
          )
        else if (id) {
          const result = validTarget(drag.source, id)
          setError(result.reason ?? t`Cannot create this relationship`)
        }
      }}
      onDragOver={dropHandlers.onDragOver}
      onDrop={dropHandlers.onDrop}
    >
      <CanvasFlow
        mode={mode}
        connectionTool={connectionTool}
        transitionMode={transitionMode}
        updateProjectionViewport={updateProjectionViewport}
        repoPath={repoPath}
        owner={owner}
        data={data}
        selectionRef={selectionRef}
        displayNodes={displayNodes}
        displayEdges={displayEdges}
        nodeTypes={nodeTypes}
        space={space}
        ready={ready}
        inspectorOpen={inspectorOpen}
        inspectorPinned={inspectorPinned}
        host={host}
        modifiedMarquee={modifiedMarquee}
        setNodes={setNodes}
        setEdges={setEdges}
        setSelection={setSelection}
        setExpanded={setExpanded}
        closeInspector={closeInspector}
        handlePreview={handlePreview}
        setHoveredNodeId={setHoveredNodeId}
        relation={relation}
        setRelationshipPreview={setRelationshipPreview}
        updateTarget={updateTarget}
        run={run}
        dragTargetRaf={dragTargetRaf}
        pendingDragNode={pendingDragNode}
        report={report}
        updateZoomCompensation={updateZoomCompensation}
        zoomRaf={zoomRaf}
        pendingZoom={pendingZoom}
        isCanvasNodeSelected={isCanvasNodeSelected}
        selectedCanvasNodeIds={selectedCanvasNodeIds}
        setMenu={setMenu}
      />
      {relationshipPreview && (
        <svg
          data-testid="relationship-preview"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-20 h-full w-full"
        >
          <line
            x1={relationshipPreview.x1}
            y1={relationshipPreview.y1}
            x2={relationshipPreview.x2}
            y2={relationshipPreview.y2}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={
              relationshipPreview.valid === null ? '6 5' : undefined
            }
            className={
              relationshipPreview.valid === false
                ? 'stroke-red-500'
                : relationshipPreview.valid
                  ? 'stroke-green-500'
                  : 'stroke-primary'
            }
          />
        </svg>
      )}
      {mode === 'edit' && connectionTool && (
        <CanvasConnectionToolStatus
          tool={connectionTool}
          anchorName={
            connectionTool === 'reverse-relationship'
              ? undefined
              : (data.images?.find((image) => image.id === connectionAnchorId)
                  ?.fileName ??
                connectionAnchorId ??
                undefined)
          }
          onExit={() => {
            connectionEvents.cancel()
            setConnectionTool(null)
            setConnectionAnchorId(null)
          }}
        />
      )}
      {target && (
        <div
          role="status"
          className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md border border-black/10 bg-card/95 px-3 py-1.5 text-xs font-medium text-ink shadow-sm"
        >
          {connectionTool
            ? connectionTool === 'reverse-relationship'
              ? target.valid
                ? t`Click to reverse relationship`
                : (target.reason ?? t`Cannot reverse this relationship`)
              : target.valid
                ? t`Click to create relationship`
                : (target.reason ?? t`Cannot create this relationship`)
            : target.valid
              ? t`Release to create relationship`
              : (target.reason ?? t`Cannot create this relationship`)}
        </div>
      )}
      {menu && menuItems.length > 0 && (
        <PositionedMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          restoreFocusOnSelect={menu.kind !== 'edge' || !!menu.keyboard}
          restoreFocusOnPointerSelect={menu.kind !== 'edge'}
          onClose={() => setMenu(null)}
        />
      )}
      {!focusCanvas && (
        <CanvasDock
          mode={
            mode === 'view' && selectedCanvasNodeIds.length > 1
              ? 'idle'
              : selectedCanvasNodeIds.length > 1
                ? 'multiple'
                : selectedCanvasNodeIds.length === 1
                  ? 'single'
                  : 'idle'
          }
          selectionCount={selectedCanvasNodeIds.length}
          canvasMode={mode}
          connectionTool={connectionTool}
          canConnect={canStartConnection}
          canFitAll={displayNodes.length > 0}
          canFitSelection={selectedCanvasNodeIds.length > 0}
          canAutoArrange={
            mode !== 'view' &&
            (mode === 'edit'
              ? displayNodes.length > 0
              : displayNodes.length >= 2 || selectedCanvasNodeIds.length > 1)
          }
          canMutateGeometry={mode !== 'view'}
          canArrangeSelection={
            actionById.get('auto-arrange-selection')?.enabled ?? false
          }
          shortcuts={{
            fitAll: actionById.get('fit-all')?.shortcut ?? '',
            fitSelection: actionById.get('fit-selection')?.shortcut ?? '',
            resetZoom: actionById.get('reset-zoom')?.shortcut ?? '',
            autoArrange: actionById.get('auto-arrange-active')?.shortcut ?? '',
            inspect: actionById.get('toggle-inspector')?.shortcut ?? '',
            unplace: actionById.get('unplace-selection')?.shortcut ?? '',
            connectDerivative:
              actionById.get('connect-derivative')?.shortcut ?? '',
            connectSource: actionById.get('connect-source')?.shortcut ?? '',
            reverseRelationship:
              actionById.get('reverse-relationship-tool')?.shortcut ?? '',
          }}
          onAction={runDockAction}
        />
      )}
      {perfHud && <PerfHud onClose={() => setPerfHud(false)} />}
    </main>
  )
}
