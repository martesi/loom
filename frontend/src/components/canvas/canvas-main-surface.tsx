import { t } from '@lingui/core/macro'
import type { Edge, Node, NodeTypes, ReactFlowInstance } from '@xyflow/react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { CanvasData } from '../../../bindings/loom/internal/service'
import { ImageService } from '../../../bindings/loom/internal/service'
import type { CanvasAction } from '../../lib/action-catalog'
import { parseAssetDragPayload } from '../../lib/asset-drag-payload'
import { filesToMedia, type readMedia } from '../../lib/clipboard'
import type { Selection } from '../../lib/selection'
import { type MenuAction, PositionedMenu } from '../menu'
import type { CanvasBoardOwner } from './canvas-board-owner'
import { CanvasDock } from './canvas-dock'
import { CanvasFlow } from './canvas-flow'
import { PerfHud } from './perf-hud'

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
    id: string
  ) => { valid: boolean; reason?: string }
  relation: MutableRefObject<{ source: number; x: number; y: number } | null>
  relationshipPreview: RelationshipPreview | null
  setRelationshipPreview: Dispatch<SetStateAction<RelationshipPreview | null>>
  updateTarget: (target: DropTarget | null) => void
  target: DropTarget | null
  run: (action: () => Promise<unknown>) => void
  paste: (
    media?: Awaited<ReturnType<typeof readMedia>>,
    surface?: Selection['surface']
  ) => Promise<void>
  dragTargetRaf: MutableRefObject<number>
  pendingDragNode: MutableRefObject<Node | null>
  reloadForData: () => Promise<CanvasData | null>
  report: (error: unknown) => void
  setError: Dispatch<SetStateAction<string>>
  assetsPinned: boolean
  closeAssets: (restoreFocus?: boolean) => void
  updateZoomCompensation: (zoom: number) => void
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
    dragTargetRaf,
    pendingDragNode,
    reloadForData,
    report,
    setError,
    assetsPinned,
    closeAssets,
    updateZoomCompensation,
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
  return (
    <main
      ref={host}
      data-canvas-surface
      aria-label={t`Canvas`}
      tabIndex={-1}
      className="absolute inset-0 min-w-0 outline-none"
      onClickCapture={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          targetAt(event.clientX, event.clientY)
        ) {
          event.stopPropagation()
          event.preventDefault()
        }
      }}
      onPointerDownCapture={(event) => {
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
        relation.current = null
        setRelationshipPreview(null)
        updateTarget(null)
      }}
      onPointerMove={(event) => {
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
        const drag = relation.current
        if (!drag) return
        event.stopPropagation()
        event.preventDefault()
        relation.current = null
        setRelationshipPreview(null)
        updateTarget(null)
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
          run(() => ImageService.LinkSource(repoPath, drag.source, Number(id)))
        else if (id) {
          const result = validTarget(drag.source, id)
          setError(result.reason ?? t`Cannot create this relationship`)
        }
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(e) => {
        e.preventDefault()
        const raw = e.dataTransfer.getData('application/x-loom-assets')
        if (raw) {
          const payload = parseAssetDragPayload(raw)
          if (!payload) {
            report(new Error('Invalid asset drag'))
            return
          }
          if (payload.repoPath !== repoPath) {
            report(new Error('This asset drag belongs to another repository'))
            return
          }
          {
            const uniqueIds = [...new Set(payload.ids)]
            const p = flow.screenToFlowPosition({
              x: e.clientX,
              y: e.clientY,
            })
            void (async () => {
              const images = await Promise.all(
                uniqueIds.map((id) => ImageService.GetImage(repoPath, id))
              )
              if (
                images.some((image) => !image || image.missing || image.trashed)
              )
                throw new Error(
                  'Missing or trashed assets cannot be placed. Refine the selection and try again.'
                )
              await ImageService.PlaceImages(repoPath, uniqueIds, p.x, p.y, 0)
              await reloadForData()
              if (!assetsPinned) {
                closeAssets(false)
                requestAnimationFrame(() => host.current?.focus())
              }
              setSelection({
                surface: 'canvas',
                ids: uniqueIds,
                edges: [],
                group: null,
              })
            })().catch(report)
          }
        } else
          void filesToMedia(Array.from(e.dataTransfer.files))
            .then((media) => paste(media, 'canvas'))
            .catch(report)
      }}
    >
      <CanvasFlow
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
      {target && (
        <div
          role="status"
          className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md border border-black/10 bg-card/95 px-3 py-1.5 text-xs font-medium text-ink shadow-sm"
        >
          {target.valid
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
            selectedCanvasNodeIds.length > 1
              ? 'multiple'
              : selectedCanvasNodeIds.length === 1
                ? 'single'
                : 'idle'
          }
          selectionCount={selectedCanvasNodeIds.length}
          canFitAll={displayNodes.length > 0}
          canFitSelection={selectedCanvasNodeIds.length > 0}
          canAutoArrange={
            displayNodes.length >= 2 || selectedCanvasNodeIds.length > 1
          }
          shortcuts={{
            fitAll: actionById.get('fit-all')?.shortcut ?? '',
            fitSelection: actionById.get('fit-selection')?.shortcut ?? '',
            resetZoom: actionById.get('reset-zoom')?.shortcut ?? '',
            autoArrange: actionById.get('auto-arrange-active')?.shortcut ?? '',
            inspect: actionById.get('toggle-inspector')?.shortcut ?? '',
            unplace: actionById.get('unplace-selection')?.shortcut ?? '',
          }}
          onAction={runDockAction}
        />
      )}
      {perfHud && <PerfHud onClose={() => setPerfHud(false)} />}
    </main>
  )
}
