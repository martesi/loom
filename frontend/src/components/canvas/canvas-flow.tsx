import { Trans } from '@lingui/react/macro'
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  type Edge,
  type Node,
  type NodeTypes,
  ReactFlow,
  SelectionMode,
  type Viewport,
} from '@xyflow/react'
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useRef,
} from 'react'
import type { CanvasData } from '../../../bindings/loom/internal/service'
import { applyCanvasNodeSelection } from '../../lib/canvas-selection'
import { emptySelection, type Selection } from '../../lib/selection'
import type { CanvasBoardOwner } from './canvas-board-owner'
import type { CanvasInternalMode } from './canvas-mode-policy'
import { unwrapCanvasOutcome } from './canvas-operation'
import { canvasEffects } from './canvas-operation-effects'
import { useCanvasBoardDrag } from './use-canvas-board-drag'

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
  data: CanvasData
  selectionRef: MutableRefObject<Selection>
  displayNodes: Node[]
  displayEdges: Edge[]
  nodeTypes: NodeTypes
  space: boolean
  ready: boolean
  inspectorOpen: boolean
  inspectorPinned: boolean
  host: MutableRefObject<HTMLDivElement | null>
  modifiedMarquee: MutableRefObject<{ active: boolean; anchor: number[] }>
  setNodes: Dispatch<SetStateAction<Node[]>>
  setEdges: Dispatch<SetStateAction<Edge[]>>
  setSelection: Dispatch<SetStateAction<Selection>>
  setExpanded: Dispatch<SetStateAction<number | null>>
  closeInspector: (restoreFocus?: boolean) => void
  handlePreview: (node: Node) => void
  setHoveredNodeId: Dispatch<SetStateAction<string | null>>
  relation: MutableRefObject<{ source: number; x: number; y: number } | null>
  setRelationshipPreview: Dispatch<SetStateAction<RelationshipPreview | null>>
  updateTarget: (target: DropTarget | null) => void
  run: (action: () => Promise<unknown>) => void
  dragTargetRaf: MutableRefObject<number>
  pendingDragNode: MutableRefObject<Node | null>
  report: (error: unknown) => void
  updateZoomCompensation: (zoom: number) => void
  updateProjectionViewport: (viewport: Viewport) => void
  zoomRaf: MutableRefObject<number>
  pendingZoom: MutableRefObject<number>
  isCanvasNodeSelected: (node: Node) => boolean
  selectedCanvasNodeIds: string[]
  setMenu: Dispatch<SetStateAction<MenuState | null>>
}

export function CanvasFlow(props: Props) {
  const keyboardContextMenu = useRef(false)
  const {
    repoPath,
    owner,
    mode,
    data,
    selectionRef,
    displayNodes,
    displayEdges,
    nodeTypes,
    space,
    ready,
    inspectorOpen,
    inspectorPinned,
    host,
    modifiedMarquee,
    setNodes,
    setEdges,
    setSelection,
    setExpanded,
    closeInspector,
    handlePreview,
    setHoveredNodeId,
    relation,
    setRelationshipPreview,
    updateTarget,
    report,
    updateZoomCompensation,
    updateProjectionViewport,
    zoomRaf,
    pendingZoom,
    isCanvasNodeSelected,
    selectedCanvasNodeIds,
    setMenu,
  } = props
  const drag = useCanvasBoardDrag(owner, data, report, setNodes)
  return (
    <>
      {displayNodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-8">
          <div className="w-full max-w-sm rounded-xl border border-black/8 bg-card/90 p-5 shadow-sm backdrop-blur-sm">
            <h2 className="text-sm font-semibold text-ink">
              <Trans>Start with an asset</Trans>
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              {(data.images ?? []).length ? (
                <Trans>Drag an asset from Assets onto the canvas.</Trans>
              ) : (
                <Trans>Import media or drop files onto the canvas.</Trans>
              )}
            </p>
            <div className="mt-4 grid gap-2 text-xs text-ink-muted">
              <p>
                <Trans>
                  Ctrl/Cmd-drag image → image to create a relationship.
                </Trans>
              </p>
            </div>
          </div>
        </div>
      )}
      <ReactFlow
        onKeyDownCapture={(event) => {
          keyboardContextMenu.current =
            event.target instanceof SVGElement &&
            event.target.matches('.react-flow__edge') &&
            (event.key === 'ContextMenu' ||
              (event.shiftKey && event.key === 'F10'))
        }}
        onPointerDownCapture={() => {
          keyboardContextMenu.current = false
        }}
        data-total-image-nodes={
          (data.images ?? []).filter((image) => image.placed && !image.trashed)
            .length
        }
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        minZoom={0.05}
        maxZoom={4}
        // Viewport culling: only mounted nodes subscribe and render, so
        // per-pointermove store fan-out and the reconciler walk scale
        // with the visible set. Offscreen nodes keep their data and
        // remount with current positions when scrolled into view.
        onlyRenderVisibleElements
        zoomOnDoubleClick={false}
        nodesConnectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode="Shift"
        selectionOnDrag={!space}
        selectionMode={SelectionMode.Partial}
        panOnScroll={!space}
        zoomOnScroll={space}
        zoomOnPinch={true}
        onSelectionStart={(event) => {
          modifiedMarquee.current = {
            active: event.shiftKey || event.ctrlKey || event.metaKey,
            anchor:
              selectionRef.current.surface === 'canvas'
                ? [...selectionRef.current.ids]
                : [],
          }
        }}
        onSelectionEnd={() => {
          modifiedMarquee.current.active = false
        }}
        panOnDrag={space ? [0, 1, 2] : [1, 2]}
        panActivationKeyCode={null}
        nodesDraggable={!space && mode !== 'view'}
        onNodesChange={(changes) => {
          if (!owner.allows('geometry'))
            changes = changes.filter(
              (change) =>
                change.type !== 'position' &&
                !(
                  change.type === 'dimensions' &&
                  (change.resizing || change.setAttributes)
                )
            )
          changes = drag.filterChanges(changes)
          setNodes((n) => applyNodeChanges(changes, n))
          const selected = changes.filter((c) => c.type === 'select')
          if (selected.length)
            setSelection((s) =>
              applyCanvasNodeSelection(
                s,
                selected,
                modifiedMarquee.current.active,
                modifiedMarquee.current.anchor
              )
            )
        }}
        onEdgesChange={(changes) => {
          setEdges((e) => applyEdgeChanges(changes, e))
          const selected = changes.filter((c) => c.type === 'select')
          if (selected.length)
            setSelection((s) => {
              const hasEdgeSelection =
                s.surface === 'canvas' && s.edges.length > 0
              if (!selected.some((c) => c.selected) && !hasEdgeSelection)
                return s
              let edgeIds = s.surface === 'canvas' ? [...s.edges] : []
              for (const c of selected)
                edgeIds = c.selected
                  ? [...new Set([...edgeIds, Number(c.id)])]
                  : edgeIds.filter((id) => id !== Number(c.id))
              return {
                surface: 'canvas',
                ids: [],
                group: null,
                edges: edgeIds,
              }
            })
        }}
        onPaneClick={() => {
          setSelection(emptySelection)
          setExpanded(null)
          if (inspectorOpen && !inspectorPinned) {
            closeInspector(false)
            host.current?.focus()
          }
        }}
        onNodeClick={(event, node) => {
          if (!(event.shiftKey || event.ctrlKey || event.metaKey))
            setSelection({
              surface: 'canvas',
              ids: [Number(node.id)],
              edges: [],
              group: null,
            })
        }}
        onNodeDoubleClick={(_, node) => {
          if (node.type === 'image') handlePreview(node)
        }}
        onNodeMouseEnter={(_, node) => setHoveredNodeId(node.id)}
        onNodeMouseLeave={() => setHoveredNodeId(null)}
        onNodeDragStart={(_, node, moved) => {
          relation.current = null
          setRelationshipPreview(null)
          updateTarget(null)
          drag.start(moved.length ? moved : [node])
        }}
        onNodeDragStop={(_, node, moved) => {
          updateTarget(null)
          const gesture = drag.take()
          if (gesture) drag.finish(gesture, moved.length ? moved : [node])
        }}
        onMoveEnd={(_, v) => {
          updateProjectionViewport(v)
          if (ready && mode === 'legacy')
            void owner
              .submit(
                {
                  kind: 'viewport',
                  mode: 'legacy',
                  board: owner.getSnapshot(),
                },
                (context) => canvasEffects.setViewport(context, repoPath, v)
              )
              .then((outcome) => {
                if (outcome.status === 'cancelled') return
                unwrapCanvasOutcome(outcome)
              })
              .catch(report)
        }}
        onMove={(_, viewport) => {
          // Zoom badges read this once per frame at most; onMove fires
          // per input event during pans.
          pendingZoom.current = viewport.zoom
          if (zoomRaf.current) return
          zoomRaf.current = requestAnimationFrame(() => {
            zoomRaf.current = 0
            updateZoomCompensation(pendingZoom.current)
          })
        }}
        onEdgeClick={(event) => {
          if (event.currentTarget instanceof SVGElement)
            event.currentTarget.focus()
        }}
        onPaneContextMenu={(event) => {
          event.preventDefault()
          setMenu({ kind: 'pane', x: event.clientX, y: event.clientY })
        }}
        onEdgeContextMenu={(event, edge) => {
          event.preventDefault()
          const edgeId = Number(edge.id)
          setSelection((current) => ({
            surface: 'canvas',
            ids: [],
            group: null,
            edges:
              current.surface === 'canvas' && current.edges.includes(edgeId)
                ? current.edges
                : [edgeId],
          }))
          setMenu({
            kind: 'edge',
            x: event.clientX,
            y: event.clientY,
            keyboard: keyboardContextMenu.current,
          })
          keyboardContextMenu.current = false
        }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault()
          const isSelected = isCanvasNodeSelected(node)
          if (isSelected && selectedCanvasNodeIds.length > 1) {
            setMenu({
              kind: 'selection',
              x: event.clientX,
              y: event.clientY,
            })
            return
          }
          setSelection({
            surface: 'canvas',
            ids: [Number(node.id)],
            edges: [],
            group: null,
          })
          setMenu({
            kind: 'node',
            x: event.clientX,
            y: event.clientY,
            nodeId: node.id,
          })
        }}
        onSelectionContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setMenu({
            kind: 'selection',
            x: event.clientX,
            y: event.clientY,
          })
        }}
      >
        <Background />
      </ReactFlow>
    </>
  )
}
