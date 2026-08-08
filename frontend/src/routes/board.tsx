import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
  Background,
  BackgroundVariant,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeTypes,
  type OnConnect,
  type OnMove,
  type OnNodeDrag,
  type OnSelectionChangeFunc,
  ReactFlow,
  type ReactFlowInstance,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { DragEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BoardData,
  BoardSummary,
  ImageInfo,
  RepoInfo,
  TagInfo,
} from '../../bindings/loom/internal/service'
import {
  BoardService,
  GroupService,
  ImageService,
  SystemService,
  TagService,
  UndoService,
} from '../../bindings/loom/internal/service'
import { BoardPicker } from '../components/board/board-picker'
import { CanvasToolbar } from '../components/board/canvas-toolbar'
import {
  FloatingPanel,
  type PanelTab,
} from '../components/board/floating-panel'
import { GroupNode, type GroupNodeData } from '../components/board/group-node'
import { ImageNode, type ImageNodeData } from '../components/board/image-node'
import type { LibraryRevealRequest } from '../components/board/library-panel'
import { LightboxViewer } from '../components/board/lightbox'
import { TagPicker } from '../components/board/tag-picker'
import { ZoomControls } from '../components/board/zoom-controls'
import type { MenuAction } from '../components/menu'
import { PositionedMenu } from '../components/menu'
import { useToast } from '../components/ui/toast'
import { computeSubgraphLayout, placeCluster } from '../lib/layout'
import { useGroupShortcut, useUndoShortcuts } from '../lib/use-undo'

const nodeTypes: NodeTypes = { image: ImageNode, group: GroupNode }

interface BoardProps {
  repo: RepoInfo
  boardId: number
}

type FlowNode = Node<ImageNodeData | GroupNodeData>

export type CanvasTool = 'select' | 'move'

// nodeIdFor/groupIdFromNode translate between xyflow's flat node-id space
// (plain image ids, or "group:<id>" for a collapsed set) and the
// image/group ids the backend actually knows about.
function nodeIdFor(imageId: number) {
  return String(imageId)
}
function groupNodeId(groupId: number) {
  return `group:${groupId}`
}

export function Board({ repo, boardId }: BoardProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [boardData, setBoardData] = useState<BoardData | null>(null)
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [allTags, setAllTags] = useState<TagInfo[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set())
  const [focusedMemberId, setFocusedMemberId] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [zoomPercent, setZoomPercent] = useState(100)
  const [tool, setTool] = useState<CanvasTool>('select')
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState(-1)
  const [panelTab, setPanelTab] = useState<PanelTab>('library')
  const [detailImageId, setDetailImageId] = useState<number | null>(null)
  const [libraryRevealRequest, setLibraryRevealRequest] =
    useState<LibraryRevealRequest | null>(null)
  const [libraryRefreshToken, setLibraryRefreshToken] = useState(0)
  const [nodeMenu, setNodeMenu] = useState<{
    x: number
    y: number
    nodeId: string
  } | null>(null)
  const [tagPickerFor, setTagPickerFor] = useState<{
    x: number
    y: number
    imageId: number
  } | null>(null)
  const [boardPickerFor, setBoardPickerFor] = useState<{
    x: number
    y: number
    imageIds: number[]
  } | null>(null)
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number } | null>(
    null
  )
  // Undo/redo state (Stage 5), restored here after Stage 7 removed it
  // along with TopNav — its only consumer at the time. Stage 11's pane
  // context menu is the new consumer: refreshUndoState is folded into
  // loadBoard (below) so every board reload — including the ones undo/redo
  // itself triggers — keeps canUndo/canRedo current.
  const [undoState, setUndoState] = useState({ canUndo: false, canRedo: false })
  // Selection unification (Stage 12): which selection toolbar actions
  // target — flipped to whichever side (canvas nodes vs. the Library
  // panel's checkbox selection) most recently became non-empty.
  const [lastSelectionSource, setLastSelectionSource] = useState<
    'canvas' | 'panel'
  >('canvas')
  const [panelSelectedIds, setPanelSelectedIds] = useState<number[]>([])

  const rfInstance = useRef<ReactFlowInstance<FlowNode, Edge> | null>(null)
  const toast = useToast()

  // Surfaces a rejected service call (e.g. cycle rejection on link
  // creation — see the data model's acyclicity rule) as a toast rather
  // than letting it fail as a silent, unhandled promise rejection. Linking
  // is the highest-value place to wire this: it's the one core mutation
  // most likely to be user-triggered-but-rejected in normal use.
  const reportError = useCallback(
    (title: string) => (err: unknown) => {
      toast.add({
        title,
        description: err instanceof Error ? err.message : String(err),
        type: 'danger',
      })
    },
    [toast]
  )

  const refreshUndoState = useCallback(() => {
    UndoService.State(repo.path).then((s) => {
      if (s) setUndoState(s)
    })
  }, [repo.path])

  const loadBoard = useCallback(() => {
    ImageService.LoadBoard(repo.path, boardId).then((data) => {
      if (!data) return
      setBoardData(data)
      setLoaded(true)
    })
    BoardService.ListBoards(repo.path).then((list) => setBoards(list ?? []))
    TagService.ListTags(repo.path).then((list) => setAllTags(list ?? []))
    refreshUndoState()
  }, [repo.path, boardId, refreshUndoState])

  useEffect(() => {
    setLoaded(false)
    loadBoard()
  }, [loadBoard])

  // The library panel tab is mounted alongside the canvas now (not a
  // separate route), so undo/redo also needs to refresh its table — done
  // via a bump token rather than a second useUndoShortcuts hook, which
  // would double-apply every Ctrl/Cmd+Z (see library-panel.tsx).
  useUndoShortcuts(repo.path, () => {
    loadBoard()
    setLibraryRefreshToken((v) => v + 1)
  })

  // Undo/Redo actions for the new pane-context-menu (Stage 11). Deliberately
  // not routed through useUndoShortcuts — that hook owns the keyboard path
  // and its own toast-on-error handling; these do the same thing for a
  // mouse-driven trigger, following the same "toast the error, only reload
  // on an actually-applied op" shape.
  const handleUndo = useCallback(() => {
    UndoService.Undo(repo.path).then((result) => {
      if (!result) return
      if (result.error) {
        reportError(t`Couldn't undo`)(result.error)
        return
      }
      if (result.applied) {
        loadBoard()
        setLibraryRefreshToken((v) => v + 1)
      }
    })
  }, [repo.path, loadBoard, reportError])

  const handleRedo = useCallback(() => {
    UndoService.Redo(repo.path).then((result) => {
      if (!result) return
      if (result.error) {
        reportError(t`Couldn't redo`)(result.error)
        return
      }
      if (result.applied) {
        loadBoard()
        setLibraryRefreshToken((v) => v + 1)
      }
    })
  }, [repo.path, loadBoard, reportError])

  // Holding Space temporarily forces pan-on-left-drag regardless of the
  // active tool (Figma/Miro convention) — see the panOnDrag/selectionOnDrag
  // computation passed to <ReactFlow> below. Guarded against text-input
  // focus so typing a literal space in the tag/rename fields doesn't hijack
  // canvas panning.
  useEffect(() => {
    const isTextInput = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !isTextInput(event.target)) {
        event.preventDefault()
        setSpaceHeld(true)
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  const groupForImage = useCallback(
    (imageId: number) =>
      boardData?.groups?.find((g) => g.memberIds?.includes(imageId)) ?? null,
    [boardData]
  )

  const resolveNodeId = useCallback(
    (imageId: number) => {
      const group = groupForImage(imageId)
      return group ? groupNodeId(group.id) : nodeIdFor(imageId)
    },
    [groupForImage]
  )

  const focusImage = useCallback(
    (imageId: number) => {
      const group = groupForImage(imageId)
      if (group) {
        setExpandedGroups((prev) => new Set(prev).add(group.id))
      }
      setFocusedMemberId(imageId)
      const targetNodeId = group ? groupNodeId(group.id) : nodeIdFor(imageId)
      requestAnimationFrame(() => {
        const node = rfInstance.current?.getNode(targetNodeId)
        if (node) {
          rfInstance.current?.setCenter(
            node.position.x + 90,
            node.position.y + 70,
            {
              zoom: 1,
              duration: 300,
            }
          )
        }
        setSelectedIds([targetNodeId])
      })
    },
    [groupForImage]
  )

  // Cross-navigation from the list view: /board/$id#img-<id> auto-expands
  // a collapsed group and pans to the specific member — see the
  // edge<->group "reveal member" correctness requirement.
  useEffect(() => {
    if (!loaded) return
    const match = window.location.hash.match(/^#img-(\d+)$/)
    if (match) {
      focusImage(Number(match[1]))
      window.history.replaceState(null, '', window.location.pathname)
    }
  }, [loaded, focusImage])

  // Rebuild xyflow nodes/edges whenever the loaded board or local
  // expand/select UI state changes. Auto layout mode computes positions
  // fresh from the graph every time (see lib/layout.ts) rather than
  // persisting them — "the board continuously re-arranges as the graph
  // changes" per spec, so there's nothing to write back to canvas_x/y.
  useEffect(() => {
    if (!boardData) return
    const images = boardData.images ?? []
    const groups = boardData.groups ?? []
    const groupedIds = new Set(groups.flatMap((g) => g.memberIds ?? []))
    const imageById = new Map(images.map((img) => [img.id, img]))

    const removeMember = (groupId: number, imageId: number) =>
      GroupService.RemoveMember(repo.path, groupId, imageId).then(loadBoard)
    const setCover = (groupId: number, imageId: number) =>
      GroupService.SetCover(repo.path, groupId, imageId).then(loadBoard)
    const ungroup = (groupId: number) =>
      GroupService.Ungroup(repo.path, groupId).then(loadBoard)

    const imageNodes: FlowNode[] = images
      .filter((img) => !groupedIds.has(img.id))
      .map((img) => ({
        id: nodeIdFor(img.id),
        type: 'image',
        position: { x: img.canvasX, y: img.canvasY },
        selected: selectedIds.includes(nodeIdFor(img.id)),
        data: {
          fileName: img.fileName,
          promptText: img.promptText,
          thumbUrl: img.thumbUrl,
          missing: img.missing,
          archived: img.archived,
        },
      }))

    const groupNodes: FlowNode[] = groups.map((g) => {
      const cover =
        imageById.get(g.coverImageId) ?? imageById.get(g.memberIds?.[0] ?? -1)
      const id = groupNodeId(g.id)
      return {
        id,
        type: 'group',
        position: { x: cover?.canvasX ?? 0, y: cover?.canvasY ?? 0 },
        selected: selectedIds.includes(id),
        data: {
          name: g.name,
          kind: g.kind,
          coverThumbUrl: cover?.thumbUrl ?? '',
          members: (g.memberIds ?? []).map((id2) => {
            const m = imageById.get(id2)
            return {
              id: id2,
              fileName: m?.fileName ?? '',
              thumbUrl: m?.thumbUrl ?? '',
              isCover: id2 === g.coverImageId,
            }
          }),
          expanded: expandedGroups.has(g.id),
          focusedMemberId,
          onToggleExpand: () =>
            setExpandedGroups((prev) => {
              const next = new Set(prev)
              if (next.has(g.id)) next.delete(g.id)
              else next.add(g.id)
              return next
            }),
          onSetCover: (imageId: number) => setCover(g.id, imageId),
          onRemoveMember: (imageId: number) => removeMember(g.id, imageId),
          onUngroup: () => ungroup(g.id),
        } satisfies GroupNodeData,
      }
    })

    let builtNodes = [...imageNodes, ...groupNodes]

    if (boardData.layoutMode === 'auto') {
      const nodeIds = builtNodes.map((n) => n.id)
      const layoutEdges = (boardData.relationships ?? [])
        .map((rel) => ({
          source: resolveNodeId(rel.sourceImageId),
          target: resolveNodeId(rel.derivedImageId),
        }))
        .filter((e) => e.source !== e.target)
      const positions = computeSubgraphLayout(nodeIds, layoutEdges)
      builtNodes = builtNodes.map((n) => {
        const pos = positions.get(n.id)
        return pos ? { ...n, position: pos } : n
      })
    }

    setNodes(builtNodes)

    const edgeMap = new Map<string, number[]>()
    for (const rel of boardData.relationships ?? []) {
      const s = resolveNodeId(rel.sourceImageId)
      const tgt = resolveNodeId(rel.derivedImageId)
      if (s === tgt) continue
      const key = `${s}->${tgt}`
      const list = edgeMap.get(key) ?? []
      list.push(rel.id)
      edgeMap.set(key, list)
    }
    setEdges(
      [...edgeMap.entries()].map(([key, relIds]) => {
        const [source, target] = key.split('->')
        return {
          id: key,
          source,
          target,
          data: { relIds },
          style: { stroke: 'rgba(0,0,0,.22)', strokeWidth: 1.6 },
        }
      })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    boardData,
    expandedGroups,
    focusedMemberId,
    resolveNodeId,
    repo.path,
    loadBoard,
    selectedIds.includes,
    setEdges,
    setNodes,
  ])

  const handleConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      if (connection.source.startsWith('group:')) return // structurally disallowed; guarded anyway
      const sourceId = Number(connection.source)
      if (connection.target.startsWith('group:')) {
        const groupId = Number(connection.target.slice('group:'.length))
        ImageService.LinkSourceToGroup(repo.path, sourceId, groupId)
          .then(loadBoard)
          .catch(reportError(t`Couldn't link`))
        return
      }
      ImageService.LinkSource(repo.path, sourceId, Number(connection.target))
        .then(loadBoard)
        .catch(reportError(t`Couldn't link`))
    },
    [repo.path, loadBoard, reportError]
  )

  const nodeIdToImageId = useCallback(
    (id: string): number | null => {
      if (id.startsWith('group:')) {
        const groupId = Number(id.slice('group:'.length))
        const group = boardData?.groups?.find((g) => g.id === groupId)
        return group?.coverImageId ?? null
      }
      return Number(id)
    },
    [boardData]
  )

  const handleNodeDragStop: OnNodeDrag<FlowNode> = useCallback(
    (_event, node) => {
      if (boardData?.layoutMode !== 'manual') return

      const persistPosition = () => {
        const imageId = nodeIdToImageId(node.id)
        if (imageId == null) return
        ImageService.SetPosition(
          repo.path,
          imageId,
          node.position.x,
          node.position.y
        )
      }

      // Groups can't be a relationship source (handleConnect guards the
      // same way — the edge<->group rules require dragging from a specific
      // expanded member instead), so a dragged group node only ever
      // repositions.
      if (node.id.startsWith('group:')) {
        persistPosition()
        return
      }

      // Hit-test the dropped node's center against every other node's
      // bounding box — landing on top of another node is a "connect"
      // gesture, not a move. `measured` is xyflow's actual rendered size
      // (set after first paint); the 150x110 fallback matches image-node.tsx
      // and group-node.tsx's collapsed size for the first render or two
      // before xyflow has measured anything.
      const draggedW = node.measured?.width ?? 150
      const draggedH = node.measured?.height ?? 110
      const center = {
        x: node.position.x + draggedW / 2,
        y: node.position.y + draggedH / 2,
      }
      const target = nodes.find((n) => {
        if (n.id === node.id) return false
        const w = n.measured?.width ?? 150
        const h = n.measured?.height ?? 110
        return (
          center.x >= n.position.x &&
          center.x <= n.position.x + w &&
          center.y >= n.position.y &&
          center.y <= n.position.y + h
        )
      })

      if (!target) {
        persistPosition()
        return
      }

      // Dropped onto another node: the dragged image becomes the relationship
      // source (matches handleConnect's argument order). Position is
      // deliberately not persisted — the loadBoard() refresh below rebuilds
      // nodes from boardData's unchanged canvas_x/y, snapping the dragged
      // node back to where it started, since the drop is a connect gesture,
      // not a move.
      const draggedImageId = Number(node.id)
      if (target.id.startsWith('group:')) {
        const groupId = Number(target.id.slice('group:'.length))
        ImageService.LinkSourceToGroup(repo.path, draggedImageId, groupId)
          .then(loadBoard)
          .catch(reportError(t`Couldn't link`))
        return
      }
      ImageService.LinkSource(repo.path, draggedImageId, Number(target.id))
        .then(loadBoard)
        .catch(reportError(t`Couldn't link`))
    },
    [repo.path, boardData, nodeIdToImageId, nodes, loadBoard, reportError]
  )

  // Drag source is panel-image-row.tsx's new `application/x-loom-image-id`
  // MIME type (single id, or a JSON array for a multi-selection drag) —
  // Stage 3 guarantees every draggable row already has a real image id, so
  // this reuses the exact same AddImagesToBoard + SetPosition pairing as
  // handleNodeDragStop, no new backend surface.
  const handleDropImages = useCallback(
    (event: DragEvent) => {
      event.preventDefault()
      const raw = event.dataTransfer.getData('application/x-loom-image-id')
      if (!raw || !rfInstance.current) return
      let imageIds: number[]
      try {
        const parsed = JSON.parse(raw)
        imageIds = Array.isArray(parsed) ? parsed.map(Number) : [Number(raw)]
      } catch {
        imageIds = [Number(raw)]
      }
      imageIds = imageIds.filter((id) => Number.isFinite(id))
      if (imageIds.length === 0) return
      const basePosition = rfInstance.current.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })
      BoardService.AddImagesToBoard(repo.path, boardId, imageIds).then(() => {
        Promise.all(
          imageIds.map((imageId, i) =>
            ImageService.SetPosition(
              repo.path,
              imageId,
              basePosition.x + i * 24,
              basePosition.y + i * 24
            )
          )
        ).then(loadBoard)
      })
    },
    [repo.path, boardId, loadBoard]
  )

  const handleDetailRequest = useCallback((imageId: number) => {
    setDetailImageId(imageId)
    setPanelTab('detail')
  }, [])

  // Plain click only selects (React Flow's own click-to-select handles
  // that) — it must not also jump the panel to Detail, matching
  // panel-image-row.tsx's existing ctrl/cmd+click-only convention for
  // Library/Explorer rows.
  const handleNodeClick: NodeMouseHandler<FlowNode> = useCallback(
    (event, node) => {
      if (!(event.ctrlKey || event.metaKey)) return
      const imageId = nodeIdToImageId(node.id)
      if (imageId != null) handleDetailRequest(imageId)
    },
    [nodeIdToImageId, handleDetailRequest]
  )

  const handleSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: sel }) => {
      setSelectedIds(sel.map((n) => n.id))
    },
    []
  )

  const handleEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      const relIds = deleted.flatMap(
        (e) => (e.data?.relIds as number[] | undefined) ?? []
      )
      Promise.all(
        relIds.map((id) => ImageService.UnlinkSource(repo.path, id))
      ).then(loadBoard)
    },
    [repo.path, loadBoard]
  )

  const selectedImageIds = useMemo(
    () =>
      selectedIds
        .filter((id) => !id.startsWith('group:'))
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id)),
    [selectedIds]
  )

  useEffect(() => {
    if (selectedImageIds.length > 0) {
      setLastSelectionSource('canvas')
    } else {
      setLastSelectionSource((prev) =>
        prev === 'canvas' && panelSelectedIds.length > 0 ? 'panel' : prev
      )
    }
  }, [selectedImageIds, panelSelectedIds])

  useEffect(() => {
    if (panelSelectedIds.length > 0) {
      setLastSelectionSource('panel')
    } else {
      setLastSelectionSource((prev) =>
        prev === 'panel' && selectedImageIds.length > 0 ? 'canvas' : prev
      )
    }
  }, [panelSelectedIds, selectedImageIds])

  // Toolbar actions (Group, Archive, Trash) target whichever selection was
  // touched most recently. Auto-arrange stays canvas-only below — it
  // repositions xyflow nodes, which only exist for images already on this
  // board's canvas.
  const activeSelection =
    lastSelectionSource === 'panel' ? panelSelectedIds : selectedImageIds
  // Falls back to whatever's open in Detail when neither canvas nor panel
  // has an active selection — e.g. after a ctrl/cmd+click from Library,
  // which sets detailImageId but neither selection array — so Archive/Trash
  // still work for "the image I'm currently looking at" now that Detail no
  // longer has its own copies of those buttons.
  const activeSelectionImageIds =
    activeSelection.length > 0
      ? activeSelection
      : detailImageId != null
        ? [detailImageId]
        : []

  const imageById = useMemo(
    () => new Map((boardData?.images ?? []).map((img) => [img.id, img])),
    [boardData]
  )

  const singleSelectedImage: ImageInfo | null = useMemo(() => {
    if (selectedIds.length !== 1 || selectedIds[0].startsWith('group:'))
      return null
    return (
      boardData?.images?.find((img) => img.id === Number(selectedIds[0])) ??
      null
    )
  }, [selectedIds, boardData])

  // Keeps Detail's content in sync with a freshly single-selected canvas
  // image WITHOUT switching the panel to the Detail tab — plain click only
  // selects (see handleNodeClick's ctrl/cmd+click gate for the one thing
  // that does switch tabs). This just means that if the user is already on
  // Detail, it follows canvas selection instead of showing a stale image.
  // Keyed on singleSelectedImage's id (a primitive), not the object itself
  // or selectedIds — boardData reloads (undo/redo, an unrelated mutation,
  // etc.) rebuild singleSelectedImage as a new object every time even when
  // the same image stays selected, which would re-fire an object- or
  // selectedIds-keyed effect on every such reload.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on the id alone, not the singleSelectedImage object — see comment above.
  useEffect(() => {
    if (singleSelectedImage) {
      setDetailImageId(singleSelectedImage.id)
    }
    // Deselecting (singleSelectedImage becomes null) deliberately leaves
    // detailImageId alone — nothing about clearing canvas selection implies
    // the user wants to stop looking at the last detail they had open.
  }, [singleSelectedImage?.id])

  const lightboxImages = boardData?.images ?? []
  const currentLightboxImage =
    lightboxIndex >= 0 ? lightboxImages[lightboxIndex] : null

  const [lightboxTagsByImage, setLightboxTagsByImage] = useState<
    Map<number, string[]>
  >(new Map())
  useEffect(() => {
    if (!currentLightboxImage) return
    TagService.TagsForImage(repo.path, currentLightboxImage.id).then((tags) => {
      setLightboxTagsByImage((prev) => {
        const next = new Map(prev)
        next.set(
          currentLightboxImage.id,
          (tags ?? []).map((tg) => tg.name)
        )
        return next
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLightboxImage?.id, repo.path, currentLightboxImage])

  const handleArchiveToggle = useCallback(
    (img: ImageInfo) => {
      ImageService.SetArchived(repo.path, img.id, !img.archived).then(loadBoard)
    },
    [repo.path, loadBoard]
  )
  const handleTrash = useCallback(
    (imageId: number) => {
      ImageService.TrashImage(repo.path, imageId).then(() => {
        setSelectedIds([])
        setDetailImageId((prev) => (prev === imageId ? null : prev))
        loadBoard()
      })
    },
    [repo.path, loadBoard]
  )

  // Undo-covered as of Stage 2 (GroupService.CreateGroup logs to the
  // operation log) — this is now the permanent home for "group as set",
  // reached via the toolbar Group button, the node context menu, and
  // Ctrl/Cmd+G (see useGroupShortcut below), replacing Stage 7's stopgap
  // floating action bar.
  const handleGroupSelection = useCallback(() => {
    if (activeSelectionImageIds.length < 2) return
    GroupService.CreateGroup(repo.path, '', '', activeSelectionImageIds).then(
      () => {
        setSelectedIds([])
        loadBoard()
      }
    )
  }, [activeSelectionImageIds, repo.path, loadBoard])

  useGroupShortcut(activeSelectionImageIds.length >= 2, handleGroupSelection)

  const activeSelectionArchived = useMemo(
    () =>
      activeSelectionImageIds.length > 0 &&
      activeSelectionImageIds.every((id) => imageById.get(id)?.archived),
    [activeSelectionImageIds, imageById]
  )

  const handleToolbarArchiveToggle = useCallback(() => {
    if (activeSelectionImageIds.length === 0) return
    const nextArchived = !activeSelectionArchived
    Promise.all(
      activeSelectionImageIds.map((id) =>
        ImageService.SetArchived(repo.path, id, nextArchived)
      )
    ).then(() => {
      loadBoard()
      setLibraryRefreshToken((v) => v + 1)
    })
  }, [activeSelectionImageIds, activeSelectionArchived, repo.path, loadBoard])

  const handleToolbarTrash = useCallback(() => {
    if (activeSelectionImageIds.length === 0) return
    Promise.all(
      activeSelectionImageIds.map((id) =>
        ImageService.TrashImage(repo.path, id)
      )
    ).then(() => {
      setSelectedIds([])
      setDetailImageId((prev) =>
        prev != null && activeSelectionImageIds.includes(prev) ? null : prev
      )
      loadBoard()
      setLibraryRefreshToken((v) => v + 1)
    })
  }, [activeSelectionImageIds, repo.path, loadBoard])

  // idsOverride lets callers (the pane menu's "Auto-arrange board") arrange
  // an explicit set of node ids instead of the current selection — reading
  // `selectedIds` directly wouldn't work there since setSelectedIds is
  // async and this needs the ids in the same call.
  const handleAutoArrange = useCallback(
    (idsOverride?: string[]) => {
      const clusterIds = idsOverride ?? selectedIds
      if (!boardData || clusterIds.length === 0) return
      const edgesAmong = (boardData.relationships ?? [])
        .map((rel) => ({
          source: resolveNodeId(rel.sourceImageId),
          target: resolveNodeId(rel.derivedImageId),
        }))
        .filter((e) => e.source !== e.target)
      const clusterLayout = computeSubgraphLayout(clusterIds, edgesAmong)
      const existingPositions = nodes
        .filter((n) => !clusterIds.includes(n.id))
        .map((n) => n.position)
      const placed = placeCluster(clusterLayout, existingPositions)

      const updates = [...placed.entries()]
        .map(([id, pos]) => {
          const imageId = nodeIdToImageId(id)
          return imageId != null ? { imageId, x: pos.x, y: pos.y } : null
        })
        .filter(
          (u): u is { imageId: number; x: number; y: number } => u !== null
        )

      if (updates.length > 0) {
        ImageService.SetPositions(repo.path, updates).then(() => {
          loadBoard()
        })
      }
    },
    [
      boardData,
      selectedIds,
      resolveNodeId,
      nodes,
      nodeIdToImageId,
      repo.path,
      loadBoard,
    ]
  )

  const openNodeMenu = useCallback(
    (event: React.MouseEvent, nodeId: string) => {
      event.preventDefault()
      setPaneMenu(null)
      setNodeMenu({ x: event.clientX, y: event.clientY, nodeId })
    },
    []
  )

  const nodeMenuItems: MenuAction[] = useMemo(() => {
    if (!nodeMenu || !boardData) return []
    if (nodeMenu.nodeId.startsWith('group:')) {
      const groupId = Number(nodeMenu.nodeId.slice('group:'.length))
      return [
        {
          key: 'ungroup',
          label: t`Ungroup`,
          onSelect: () =>
            GroupService.Ungroup(repo.path, groupId).then(loadBoard),
        },
      ]
    }
    const imageId = Number(nodeMenu.nodeId)
    const img = boardData.images?.find((i) => i.id === imageId)
    if (!img) return []
    const group = groupForImage(imageId)

    const items: MenuAction[] = [
      {
        key: 'reveal',
        label: t`Show in file explorer`,
        onSelect: () => SystemService.RevealInFileExplorer(img.filePath),
      },
      {
        key: 'find-in-list',
        label: t`Find in list`,
        onSelect: () => {
          setPanelTab('library')
          setLibraryRevealRequest({ imageId, token: Date.now() })
        },
      },
      {
        key: 'preview',
        label: t`Open preview`,
        onSelect: () => {
          const idx = (boardData.images ?? []).findIndex(
            (i) => i.id === imageId
          )
          if (idx >= 0) setLightboxIndex(idx)
        },
      },
      {
        key: 'add-board',
        label: t`Add to board…`,
        separatorBefore: true,
        onSelect: () =>
          setBoardPickerFor({
            x: nodeMenu.x,
            y: nodeMenu.y,
            imageIds: [imageId],
          }),
      },
      {
        key: 'add-tag',
        label: t`Add tag…`,
        onSelect: () =>
          setTagPickerFor({ x: nodeMenu.x, y: nodeMenu.y, imageId }),
      },
    ]
    if (group) {
      items.push({
        key: 'set-cover',
        label: t`Set as cover`,
        onSelect: () =>
          GroupService.SetCover(repo.path, group.id, imageId).then(loadBoard),
      })
    }
    // Multi-selection actions (Stage 11) — only offered when the
    // right-clicked node is itself part of the current >=2-image
    // selection, mirroring the toolbar's Group/Auto-arrange enable
    // conditions rather than acting on just the one node clicked.
    if (selectedImageIds.includes(imageId) && selectedImageIds.length >= 2) {
      items.push({
        key: 'group-as-set',
        label: t`Group as set`,
        separatorBefore: true,
        onSelect: handleGroupSelection,
      })
      if (boardData.layoutMode === 'manual') {
        items.push({
          key: 'auto-arrange-selection',
          label: t`Auto-arrange selection`,
          onSelect: handleAutoArrange,
        })
      }
    }
    items.push(
      {
        key: 'archive',
        label: img.archived ? t`Unarchive` : t`Archive`,
        separatorBefore: true,
        onSelect: () => handleArchiveToggle(img),
      },
      {
        key: 'trash',
        label: t`Trash`,
        danger: true,
        onSelect: () => handleTrash(imageId),
      }
    )
    return items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    nodeMenu,
    boardData,
    groupForImage,
    repo.path,
    loadBoard,
    handleTrash,
    handleArchiveToggle,
    selectedImageIds,
    handleGroupSelection,
    handleAutoArrange,
  ])

  // Empty-canvas right-click menu (Stage 11) — Undo/Redo, the same actions
  // the deleted TopNav buttons drove, now reached via onPaneContextMenu
  // instead of dedicated toolbar buttons; Select all/Auto-arrange board give
  // it real content beyond those two.
  const paneMenuItems: MenuAction[] = useMemo(
    () => [
      {
        key: 'select-all',
        label: t`Select all`,
        disabled: nodes.length === 0,
        onSelect: () => setSelectedIds(nodes.map((n) => n.id)),
      },
      {
        key: 'auto-arrange-board',
        label: t`Auto-arrange board`,
        disabled: boardData?.layoutMode !== 'manual' || nodes.length === 0,
        onSelect: () => handleAutoArrange(nodes.map((n) => n.id)),
      },
      {
        key: 'undo',
        label: t`Undo`,
        separatorBefore: true,
        disabled: !undoState.canUndo,
        onSelect: handleUndo,
      },
      {
        key: 'redo',
        label: t`Redo`,
        disabled: !undoState.canRedo,
        onSelect: handleRedo,
      },
    ],
    [
      nodes,
      boardData?.layoutMode,
      handleAutoArrange,
      undoState,
      handleUndo,
      handleRedo,
    ]
  )

  const handleMove: OnMove = useCallback((_event, viewport) => {
    setZoomPercent(Math.round(viewport.zoom * 100))
  }, [])

  // Middle-mouse (button 1) always pans regardless of tool; holding Space
  // forces left-drag (button 0) to pan too, temporarily overriding the
  // active tool. Right-click (button 2) is deliberately never included —
  // it must stay free for onPaneContextMenu.
  const panOnDrag = spaceHeld || tool === 'move' ? [0, 1] : [1]
  const selectionOnDrag = !spaceHeld && tool === 'select'

  if (!loaded || !boardData) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-canvas text-ink-subtle">
        <Trans>Loading board…</Trans>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-surface-canvas">
      {/* TopNav is gone entirely (Stage 7) — the canvas is now the only
          pane, full-width/relative flex-1, with FloatingPanel and the
          canvas toolbars layered on top as absolute-positioned siblings
          rather than flex siblings, so the canvas stays fully interactive
          underneath (see Stage 12's drag-and-drop). */}
      <div
        className="relative flex-1"
        onDragOver={(event) => {
          if (
            event.dataTransfer.types.includes('application/x-loom-image-id')
          ) {
            event.preventDefault()
          }
        }}
        onDrop={handleDropImages}
      >
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={handleConnect}
            onNodeDragStop={handleNodeDragStop}
            onNodeClick={handleNodeClick}
            onNodeContextMenu={(event, node) => openNodeMenu(event, node.id)}
            onPaneContextMenu={(event) => {
              event.preventDefault()
              setNodeMenu(null)
              setPaneMenu({ x: event.clientX, y: event.clientY })
            }}
            onSelectionChange={handleSelectionChange}
            onEdgesDelete={handleEdgesDelete}
            onPaneClick={() => {
              setSelectedIds([])
            }}
            onMove={handleMove}
            onInit={(instance) => {
              rfInstance.current = instance
            }}
            nodesDraggable={boardData.layoutMode === 'manual'}
            panOnDrag={panOnDrag}
            selectionOnDrag={selectionOnDrag}
            defaultEdgeOptions={{
              style: { stroke: 'rgba(0,0,0,.22)', strokeWidth: 1.6 },
            }}
            multiSelectionKeyCode="Shift"
            deleteKeyCode={['Backspace', 'Delete']}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={22}
              size={1}
              color="rgba(0,0,0,.07)"
            />
          </ReactFlow>
        </ReactFlowProvider>

        <CanvasToolbar
          tool={tool}
          onToolChange={setTool}
          onGroupSelection={handleGroupSelection}
          groupDisabled={activeSelectionImageIds.length < 2}
          onAutoArrange={() => handleAutoArrange()}
          autoArrangeDisabled={
            !(boardData.layoutMode === 'manual' && selectedIds.length > 0)
          }
          onArchiveToggle={handleToolbarArchiveToggle}
          archiveDisabled={activeSelectionImageIds.length === 0}
          archiveActive={activeSelectionArchived}
          onTrash={handleToolbarTrash}
          trashDisabled={activeSelectionImageIds.length === 0}
        />

        <ZoomControls
          zoomPercent={zoomPercent}
          onZoomIn={() => rfInstance.current?.zoomIn({ duration: 150 })}
          onZoomOut={() => rfInstance.current?.zoomOut({ duration: 150 })}
          onFitView={() => rfInstance.current?.fitView({ duration: 200 })}
        />

        <FloatingPanel
          repo={repo}
          boards={boards}
          currentBoardId={boardId}
          currentBoardName={boardData.boardName}
          onBoardsChanged={loadBoard}
          onRevealOnCanvas={focusImage}
          activeTab={panelTab}
          onActiveTabChange={setPanelTab}
          libraryRevealRequest={libraryRevealRequest}
          libraryRefreshToken={libraryRefreshToken}
          detailImageId={detailImageId}
          boardImages={boardData.images ?? []}
          onDetailRequest={handleDetailRequest}
          layoutMode={boardData.layoutMode}
          onLayoutModeChange={loadBoard}
          onRescan={loadBoard}
          onPanelSelectionChange={setPanelSelectedIds}
        />

        {/* Stage 7's stopgap floating action bar (Auto-arrange/Group-as-set
            with no permanent home yet) is gone — Stage 11 gives both a real
            home: CanvasToolbar buttons, the node context menu, and
            Ctrl/Cmd+G for grouping. Linking is now drag-one-node-onto-another
            (see handleNodeDragStop) instead of a click-arm-then-click-target
            mode, so there's no "linking in progress" banner anymore either. */}

        {nodeMenu && (
          <PositionedMenu
            x={nodeMenu.x}
            y={nodeMenu.y}
            items={nodeMenuItems}
            onClose={() => setNodeMenu(null)}
          />
        )}
        {paneMenu && (
          <PositionedMenu
            x={paneMenu.x}
            y={paneMenu.y}
            items={paneMenuItems}
            onClose={() => setPaneMenu(null)}
          />
        )}
        {tagPickerFor && (
          <TagPicker
            x={tagPickerFor.x}
            y={tagPickerFor.y}
            repoPath={repo.path}
            imageId={tagPickerFor.imageId}
            allTagNames={allTags.map((tg) => tg.name)}
            onClose={() => setTagPickerFor(null)}
            onChange={() =>
              TagService.ListTags(repo.path).then((l) => setAllTags(l ?? []))
            }
          />
        )}
        {boardPickerFor && (
          <BoardPicker
            x={boardPickerFor.x}
            y={boardPickerFor.y}
            repoPath={repo.path}
            imageIds={boardPickerFor.imageIds}
            boards={boards}
            onClose={() => setBoardPickerFor(null)}
            onChange={loadBoard}
          />
        )}
      </div>

      {currentLightboxImage && (
        <LightboxViewer
          images={lightboxImages}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(-1)}
          onIndexChange={setLightboxIndex}
          tagsForImage={(imageId) => lightboxTagsByImage.get(imageId) ?? []}
          boardName={boardData.boardName}
          sourcesFor={(imageId) =>
            (boardData.relationships ?? [])
              .filter((r) => r.derivedImageId === imageId)
              .map((r) =>
                boardData.images?.find((i) => i.id === r.sourceImageId)
              )
              .filter((i): i is ImageInfo => !!i)
              .map((i) => ({
                id: i.id,
                fileName: i.fileName,
                thumbUrl: i.thumbUrl,
              }))
          }
          onJumpTo={(imageId) => {
            const idx = lightboxImages.findIndex((i) => i.id === imageId)
            if (idx >= 0) setLightboxIndex(idx)
          }}
        />
      )}
    </div>
  )
}
