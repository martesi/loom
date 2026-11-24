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
} from '@xyflow/react'
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useRef,
} from 'react'
import type { CanvasData } from '../../../bindings/loom/internal/service'
import { ImageService } from '../../../bindings/loom/internal/service'
import { applyCanvasNodeSelection } from '../../lib/canvas-selection'
import { emptySelection, type Selection } from '../../lib/selection'

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
  kind: 'relationship' | 'set'
  reason?: string
  members?: number
}

interface Props {
  repoPath: string
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
  dropTargets: MutableRefObject<Node[]>
  setNodes: Dispatch<SetStateAction<Node[]>>
  setEdges: Dispatch<SetStateAction<Edge[]>>
  setSelection: Dispatch<SetStateAction<Selection>>
  setExpanded: Dispatch<SetStateAction<number | null>>
  closeInspector: (restoreFocus?: boolean) => void
  groupMembers: (id: number) => number[]
  expanded: number | null
  handlePreview: (node: Node) => void
  setHoveredNodeId: Dispatch<SetStateAction<string | null>>
  relation: MutableRefObject<{ source: number; x: number; y: number } | null>
  setRelationshipPreview: Dispatch<SetStateAction<RelationshipPreview | null>>
  updateTarget: (target: DropTarget | null) => void
  run: (action: () => Promise<unknown>) => void
  resolveSetDropTarget: (node: Node) => Node | null
  dragTargetRaf: MutableRefObject<number>
  pendingDragNode: MutableRefObject<Node | null>
  report: (error: unknown) => void
  updateZoomCompensation: (zoom: number) => void
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
    dropTargets,
    setNodes,
    setEdges,
    setSelection,
    setExpanded,
    closeInspector,
    groupMembers,
    expanded,
    handlePreview,
    setHoveredNodeId,
    relation,
    setRelationshipPreview,
    updateTarget,
    run,
    resolveSetDropTarget,
    dragTargetRaf,
    pendingDragNode,
    report,
    updateZoomCompensation,
    zoomRaf,
    pendingZoom,
    isCanvasNodeSelected,
    selectedCanvasNodeIds,
    setMenu,
  } = props
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
                  Ctrl/Cmd-drag image → image or set to create a relationship.
                </Trans>
              </p>
              <p>
                <Trans>
                  Select 2+ images, then Create set or press Ctrl/Cmd+G.
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
        nodesDraggable={!space}
        onNodesChange={(changes) => {
          if (dropTargets.current.length) {
            const movedGroups = new Map(
              changes.flatMap((change) =>
                change.type === 'position' &&
                change.position &&
                change.id.startsWith('set-')
                  ? [[change.id, change.position] as const]
                  : []
              )
            )
            if (movedGroups.size)
              dropTargets.current = dropTargets.current.map((group) => {
                const position = movedGroups.get(group.id)
                return position ? { ...group, position } : group
              })
          }
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
            setSelection(
              node.type === 'group'
                ? {
                    surface: 'canvas',
                    ids: groupMembers(Number(node.id.slice(4))),
                    edges: [],
                    group: Number(node.id.slice(4)),
                  }
                : {
                    surface: 'canvas',
                    ids: [Number(node.id)],
                    edges: [],
                    group: null,
                  }
            )
          if (
            node.type === 'image' &&
            data.images?.find((i) => String(i.id) === node.id)?.groupId !==
              expanded
          )
            setExpanded(null)
        }}
        onNodeDoubleClick={(_, node) => {
          if (node.type === 'group') {
            setExpanded(Number(node.id.slice(4)))
            setSelection({
              surface: 'canvas',
              ids: groupMembers(Number(node.id.slice(4))),
              edges: [],
              group: null,
            })
          } else if (node.type === 'image') handlePreview(node)
        }}
        onNodeMouseEnter={(_, node) => setHoveredNodeId(node.id)}
        onNodeMouseLeave={() => setHoveredNodeId(null)}
        onNodeDragStart={() => {
          relation.current = null
          setRelationshipPreview(null)
          updateTarget(null)
        }}
        onNodeDrag={(_, node) => {
          if (node.type !== 'image') return
          // Coalesce pointermove bursts to one target resolution per frame.
          pendingDragNode.current = node
          if (dragTargetRaf.current) return
          dragTargetRaf.current = requestAnimationFrame(() => {
            dragTargetRaf.current = 0
            const current = pendingDragNode.current
            pendingDragNode.current = null
            if (!current) return
            const group = resolveSetDropTarget(current)
            updateTarget(
              group
                ? {
                    id: group.id,
                    valid: true,
                    kind: 'set',
                    reason: 'Release to add or move into this set',
                  }
                : null
            )
          })
        }}
        onNodeDragStop={(_, node, moved) => {
          if (dragTargetRaf.current) {
            cancelAnimationFrame(dragTargetRaf.current)
            dragTargetRaf.current = 0
          }
          pendingDragNode.current = null
          updateTarget(null)
          run(async () => {
            if (node.type === 'group') {
              const group = (data.groups ?? []).find(
                (g) => `set-${g.id}` === node.id
              )
              if (!group) return
              const members = (data.images ?? []).filter(
                (i) => (group.memberIds ?? []).includes(i.id) && i.placed
              )
              const dx =
                  node.position.x - Math.min(...members.map((i) => i.canvasX)),
                dy =
                  node.position.y - Math.min(...members.map((i) => i.canvasY))
              await ImageService.SetPositions(
                repoPath,
                members.map((i) => ({
                  imageId: i.id,
                  x: i.canvasX + dx,
                  y: i.canvasY + dy,
                }))
              )
              return
            }
            const target = resolveSetDropTarget(node)
            if (target) {
              await ImageService.PlaceImages(
                repoPath,
                moved.map((n) => Number(n.id)),
                node.position.x,
                node.position.y,
                Number(target.id.slice(4))
              )
              return
            }
            await ImageService.SetPositions(
              repoPath,
              moved
                .filter((n) => n.type === 'image')
                .map((n) => ({ imageId: Number(n.id), ...n.position }))
            )
          })
        }}
        onMoveEnd={(_, v) => {
          if (ready) void ImageService.SetViewport(repoPath, v).catch(report)
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
          setSelection(
            node.type === 'group'
              ? {
                  surface: 'canvas',
                  ids: groupMembers(Number(node.id.slice(4))),
                  edges: [],
                  group: Number(node.id.slice(4)),
                }
              : {
                  surface: 'canvas',
                  ids: [Number(node.id)],
                  edges: [],
                  group: null,
                }
          )
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
