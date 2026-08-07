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
import { useNavigate } from '@tanstack/react-router'
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
import { BoardSwitcher } from '../components/board/board-switcher'
import { CanvasToolbar } from '../components/board/canvas-toolbar'
import { GroupNode, type GroupNodeData } from '../components/board/group-node'
import { ImageNode, type ImageNodeData } from '../components/board/image-node'
import { LightboxViewer } from '../components/board/lightbox'
import { TagPicker } from '../components/board/tag-picker'
import { ZoomControls } from '../components/board/zoom-controls'
import type { MenuAction } from '../components/menu'
import { PositionedMenu } from '../components/menu'
import { TopNav } from '../components/top-nav'
import { Button } from '../components/ui/button'
import { computeSubgraphLayout, placeCluster } from '../lib/layout'
import { useUndoShortcuts } from '../lib/use-undo'

const nodeTypes: NodeTypes = { image: ImageNode, group: GroupNode }

interface BoardProps {
  repo: RepoInfo
  boardId: number
}

type FlowNode = Node<ImageNodeData | GroupNodeData>

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
  const [linkingTargetId, setLinkingTargetId] = useState<string | null>(null)
  const [lightboxIndex, setLightboxIndex] = useState(-1)
  const [undoState, setUndoState] = useState({ canUndo: false, canRedo: false })
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

  const rfInstance = useRef<ReactFlowInstance<FlowNode, Edge> | null>(null)
  const navigate = useNavigate()

  const refreshUndoState = useCallback(() => {
    UndoService.State(repo.path).then((s) => s && setUndoState(s))
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

  useUndoShortcuts(repo.path, loadBoard)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLinkingTargetId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
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
        ImageService.LinkSourceToGroup(repo.path, sourceId, groupId).then(
          loadBoard
        )
        return
      }
      ImageService.LinkSource(
        repo.path,
        sourceId,
        Number(connection.target)
      ).then(loadBoard)
    },
    [repo.path, loadBoard]
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
      const imageId = nodeIdToImageId(node.id)
      if (imageId == null) return
      ImageService.SetPosition(
        repo.path,
        imageId,
        node.position.x,
        node.position.y
      ).then(refreshUndoState)
    },
    [repo.path, boardData, nodeIdToImageId, refreshUndoState]
  )

  const handleNodeClick: NodeMouseHandler<FlowNode> = useCallback(
    (_event, node) => {
      if (linkingTargetId) {
        if (node.id !== linkingTargetId) {
          const sourceImageId = nodeIdToImageId(node.id)
          if (sourceImageId != null) {
            if (linkingTargetId.startsWith('group:')) {
              ImageService.LinkSourceToGroup(
                repo.path,
                sourceImageId,
                Number(linkingTargetId.slice('group:'.length))
              ).then(loadBoard)
            } else {
              ImageService.LinkSource(
                repo.path,
                sourceImageId,
                Number(linkingTargetId)
              ).then(loadBoard)
            }
          }
        }
        setLinkingTargetId(null)
      }
    },
    [linkingTargetId, repo.path, loadBoard, nodeIdToImageId]
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

  const singleSelectedImage: ImageInfo | null = useMemo(() => {
    if (selectedIds.length !== 1 || selectedIds[0].startsWith('group:'))
      return null
    return (
      boardData?.images?.find((img) => img.id === Number(selectedIds[0])) ??
      null
    )
  }, [selectedIds, boardData])

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
      ImageService.SetArchived(repo.path, img.id, !img.archived).then(() => {
        loadBoard()
        refreshUndoState()
      })
    },
    [repo.path, loadBoard, refreshUndoState]
  )
  const handleTrash = useCallback(
    (imageId: number) => {
      ImageService.TrashImage(repo.path, imageId).then(() => {
        setSelectedIds([])
        loadBoard()
      })
    },
    [repo.path, loadBoard]
  )

  const handleGroupSelection = () => {
    if (selectedImageIds.length < 2) return
    GroupService.CreateGroup(repo.path, '', '', selectedImageIds).then(() => {
      setSelectedIds([])
      loadBoard()
    })
  }

  const handleAutoArrange = () => {
    if (!boardData || selectedIds.length === 0) return
    const clusterIds = selectedIds
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
      .filter((u): u is { imageId: number; x: number; y: number } => u !== null)

    if (updates.length > 0) {
      ImageService.SetPositions(repo.path, updates).then(() => {
        loadBoard()
      })
    }
  }

  const handleUndo = () =>
    UndoService.Undo(repo.path).then((result) => {
      if (result?.applied) loadBoard()
      refreshUndoState()
    })
  const handleRedo = () =>
    UndoService.Redo(repo.path).then((result) => {
      if (result?.applied) loadBoard()
      refreshUndoState()
    })

  const openNodeMenu = useCallback(
    (event: React.MouseEvent, nodeId: string) => {
      event.preventDefault()
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
          navigate({ to: '/library', hash: `img-${imageId}` })
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
    navigate,
    handleTrash,
    handleArchiveToggle,
  ])

  const handleMove: OnMove = useCallback((_event, viewport) => {
    setZoomPercent(Math.round(viewport.zoom * 100))
  }, [])

  if (!loaded || !boardData) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-canvas text-ink-subtle">
        <Trans>Loading board…</Trans>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-surface-canvas">
      <TopNav
        repoName={repo.name}
        active="canvas"
        boardHref={`/board/${boardId}`}
        canUndo={undoState.canUndo}
        canRedo={undoState.canRedo}
        onUndo={handleUndo}
        onRedo={handleRedo}
      >
        <BoardSwitcher
          repoPath={repo.path}
          boards={boards}
          currentBoardId={boardId}
          currentBoardName={boardData.boardName}
          onBoardsChanged={loadBoard}
        />
        <div className="flex gap-0.5 rounded-sm bg-surface p-0.5">
          <button
            type="button"
            onClick={() =>
              BoardService.SetLayoutMode(repo.path, boardId, 'manual').then(
                loadBoard
              )
            }
            className={
              boardData.layoutMode === 'manual'
                ? 'rounded-[3px] bg-white px-2.5 py-1 text-[11.5px] font-semibold text-ink shadow-sm'
                : 'rounded-[3px] px-2.5 py-1 text-[11.5px] font-semibold text-ink-subtle'
            }
          >
            <Trans>Manual</Trans>
          </button>
          <button
            type="button"
            onClick={() =>
              BoardService.SetLayoutMode(repo.path, boardId, 'auto').then(
                loadBoard
              )
            }
            className={
              boardData.layoutMode === 'auto'
                ? 'rounded-[3px] bg-white px-2.5 py-1 text-[11.5px] font-semibold text-ink shadow-sm'
                : 'rounded-[3px] px-2.5 py-1 text-[11.5px] font-semibold text-ink-subtle'
            }
          >
            <Trans>Auto</Trans>
          </button>
        </div>
        {boardData.layoutMode === 'manual' && selectedIds.length > 0 && (
          <Button variant="secondary" size="sm" onClick={handleAutoArrange}>
            <Trans>Auto-arrange selection</Trans>
          </Button>
        )}
        {selectedImageIds.length >= 2 && (
          <Button variant="secondary" size="sm" onClick={handleGroupSelection}>
            <Trans>Group as set</Trans>
          </Button>
        )}
        <div className="text-xs text-ink-subtle">{zoomPercent}%</div>
      </TopNav>

      <div className="relative flex-1">
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
            onSelectionChange={handleSelectionChange}
            onEdgesDelete={handleEdgesDelete}
            onPaneClick={() => {
              setSelectedIds([])
              setLinkingTargetId(null)
            }}
            onMove={handleMove}
            onInit={(instance) => {
              rfInstance.current = instance
            }}
            nodesDraggable={boardData.layoutMode === 'manual'}
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

        <CanvasToolbar onRescan={loadBoard} />

        <ZoomControls
          zoomPercent={zoomPercent}
          onZoomIn={() => rfInstance.current?.zoomIn({ duration: 150 })}
          onZoomOut={() => rfInstance.current?.zoomOut({ duration: 150 })}
          onFitView={() => rfInstance.current?.fitView({ duration: 200 })}
        />

        {linkingTargetId && (
          <div className="absolute left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-2.5 rounded-md border border-black/8 bg-ink px-3.5 py-2 shadow-lg">
            <span className="text-[12px] font-semibold text-white">
              <Trans>Click a node to set as source — Esc to cancel</Trans>
            </span>
          </div>
        )}

        {singleSelectedImage && (
          <SidePanel
            repo={repo}
            image={singleSelectedImage}
            boards={boards}
            onClose={() => setSelectedIds([])}
            onLinkSource={() =>
              setLinkingTargetId(nodeIdFor(singleSelectedImage.id))
            }
            onArchive={() => handleArchiveToggle(singleSelectedImage)}
            onTrash={() => handleTrash(singleSelectedImage.id)}
            onChange={loadBoard}
          />
        )}

        {nodeMenu && (
          <PositionedMenu
            x={nodeMenu.x}
            y={nodeMenu.y}
            items={nodeMenuItems}
            onClose={() => setNodeMenu(null)}
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

interface SidePanelProps {
  repo: RepoInfo
  image: ImageInfo
  boards: BoardSummary[]
  onClose: () => void
  onLinkSource: () => void
  onArchive: () => void
  onTrash: () => void
  onChange: () => void
}

function SidePanel({
  repo,
  image,
  boards,
  onClose,
  onLinkSource,
  onArchive,
  onTrash,
  onChange,
}: SidePanelProps) {
  const [tags, setTags] = useState<TagInfo[]>([])
  const [imageBoards, setImageBoards] = useState<BoardSummary[]>([])
  const [tagInput, setTagInput] = useState('')

  useEffect(() => {
    TagService.TagsForImage(repo.path, image.id).then((t2) => setTags(t2 ?? []))
    BoardService.BoardsForImage(repo.path, image.id).then((b) =>
      setImageBoards(b ?? [])
    )
  }, [repo.path, image.id])

  const addTag = async () => {
    const name = tagInput.trim()
    if (!name) return
    await TagService.AddTag(repo.path, image.id, name)
    setTagInput('')
    TagService.TagsForImage(repo.path, image.id).then((t2) => setTags(t2 ?? []))
    onChange()
  }

  return (
    <div className="absolute right-4 top-4 bottom-4 flex w-[280px] flex-col gap-4 overflow-y-auto rounded-lg border border-black/8 bg-card/96 p-4 shadow-lg backdrop-blur">
      <div className="flex items-center justify-between">
        <span className="truncate text-[13px] font-semibold text-ink">
          {image.fileName}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-[15px] text-ink-subtle hover:text-ink"
        >
          ×
        </button>
      </div>

      {image.missing && (
        <div className="rounded-md bg-danger-soft px-3 py-2 text-[11.5px] text-danger">
          <Trans>File not found on disk</Trans>
        </div>
      )}

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
          <Trans>Prompt</Trans>
        </div>
        <div className="rounded-md bg-surface px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-muted">
          {image.promptText || <Trans>No prompt attached</Trans>}
        </div>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
          <Trans>Tags</Trans>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              onClick={async () => {
                await TagService.RemoveTag(repo.path, image.id, tag.id)
                setTags((prev) => prev.filter((t2) => t2.id !== tag.id))
                onChange()
              }}
              title={t`Remove tag`}
              className="rounded-full bg-surface px-2.5 py-0.5 text-[11px] text-ink-muted hover:bg-danger-soft hover:text-danger"
            >
              {tag.name}
            </button>
          ))}
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTag()}
            placeholder={t`+ add`}
            className="w-16 rounded-full border border-dashed border-black/18 bg-transparent px-2.5 py-0.5 text-[11px] text-ink-subtle outline-none focus:border-accent"
          />
        </div>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
          <Trans>Boards</Trans>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {imageBoards.map((b) => (
            <button
              key={b.id}
              type="button"
              title={t`Remove from board`}
              onClick={async () => {
                await BoardService.RemoveImagesFromBoard(repo.path, b.id, [
                  image.id,
                ])
                onChange()
              }}
              className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] text-accent hover:bg-danger-soft hover:text-danger"
            >
              {b.name}
            </button>
          ))}
          {boards
            .filter((b) => !imageBoards.some((ib) => ib.id === b.id))
            .map((b) => (
              <button
                key={b.id}
                type="button"
                title={t`Add to board`}
                onClick={async () => {
                  await BoardService.AddImagesToBoard(repo.path, b.id, [
                    image.id,
                  ])
                  onChange()
                }}
                className="rounded-full border border-dashed border-black/18 px-2.5 py-0.5 text-[11px] text-ink-subtle hover:border-accent hover:text-accent"
              >
                + {b.name}
              </button>
            ))}
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-2">
        <Button variant="secondary" size="sm" onClick={onLinkSource}>
          <Trans>Link source…</Trans>
        </Button>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="flex-1"
            onClick={onArchive}
          >
            {image.archived ? <Trans>Unarchive</Trans> : <Trans>Archive</Trans>}
          </Button>
          <Button
            variant="danger"
            size="sm"
            className="flex-1"
            onClick={onTrash}
          >
            <Trans>Trash</Trans>
          </Button>
        </div>
      </div>
    </div>
  )
}
