import { type Edge, MarkerType, type Node } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type CanvasData,
  ImageService,
} from '../../../bindings/loom/internal/service'
import { renditionGenerationUrl } from '../../lib/preview-tier'
import type { Selection } from '../../lib/selection'

interface CanvasDropTarget {
  id: string
  valid: boolean
  kind: 'relationship' | 'set'
  reason?: string
  members?: number
}

interface Callbacks {
  run: (action: () => Promise<unknown>) => void
}

interface Props {
  data: CanvasData
  expanded: number | null
  repoPath: string
  renditionGeneration: number
  callbacks: { current: Callbacks }
  selection: Selection
  nodes: Node[]
  setNodes: (update: Node[] | ((nodes: Node[]) => Node[])) => void
  edges: Edge[]
  setEdges: (update: Edge[] | ((edges: Edge[]) => Edge[])) => void
  target: CanvasDropTarget | null
  dropTargets: { current: Node[] }
}

export function useCanvasBoardModel({
  data,
  expanded,
  repoPath,
  renditionGeneration,
  callbacks,
  selection,
  nodes,
  setNodes,
  edges,
  setEdges,
  target,
  dropTargets,
}: Props) {
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const previousDisplayNodes = useRef(new Map<string, Node>())
  const selectedImageIds = useMemo(
    () => new Set(selection.ids),
    [selection.ids]
  )
  const placedImageIds = useMemo(
    () =>
      new Set(
        (data.images ?? [])
          .filter((image) => image.placed && !image.trashed)
          .map((image) => image.id)
      ),
    [data.images]
  )
  const groupMemberMap = useMemo(
    () =>
      new Map(
        (data.groups ?? []).map(
          (group) => [group.id, new Set(group.memberIds ?? [])] as const
        )
      ),
    [data.groups]
  )
  const selectedIdsList = useMemo(
    () => [
      ...new Set([
        ...selection.ids,
        ...(selection.group
          ? [...(groupMemberMap.get(selection.group) ?? [])]
          : []),
      ]),
    ],
    [selection.ids, selection.group, groupMemberMap]
  )

  useEffect(() => {
    const placed = (data.images ?? []).filter(
      (image) => image.placed && !image.trashed
    )
    const collapsed = (data.groups ?? []).filter(
      (group) =>
        group.id !== expanded &&
        (group.memberIds ?? []).some((id) =>
          placed.some((image) => image.id === id)
        )
    )
    const groupByImage = new Map(
      collapsed.flatMap((group) =>
        (group.memberIds ?? []).map((id) => [id, `set-${group.id}`] as const)
      )
    )
    const imageNodes: Node[] = placed
      .filter((image) => !groupByImage.has(image.id))
      .map((image) => ({
        id: String(image.id),
        type: 'image',
        position: { x: image.canvasX, y: image.canvasY },
        width: image.canvasW || 150,
        height: image.canvasH || 110,
        data: {
          fileName: image.fileName,
          thumbUrl: renditionGenerationUrl(image.thumbUrl, renditionGeneration),
          previewUrl: image.previewUrl
            ? renditionGenerationUrl(image.previewUrl, renditionGeneration)
            : undefined,
          missing: image.missing,
          showFileName: true,
          width: image.width,
          height: image.height,
          onResizeEnd: (x: number, y: number, width: number, height: number) =>
            callbacks.current.run(async () => {
              await ImageService.SetGeometry(repoPath, [
                { imageId: image.id, x, y, w: width, h: height },
              ])
            }),
        },
      }))
    const groups: Node[] = collapsed.map((group) => {
      const members = placed.filter((image) =>
        (group.memberIds ?? []).includes(image.id)
      )
      const cover =
        members.find((image) => image.id === group.coverImageId) ?? members[0]
      return {
        id: `set-${group.id}`,
        type: 'group',
        position: {
          x: Math.min(...members.map((image) => image.canvasX)),
          y: Math.min(...members.map((image) => image.canvasY)),
        },
        width: 160,
        height: 128,
        data: {
          name: group.name || cover.fileName,
          thumbUrl: renditionGenerationUrl(cover.thumbUrl, renditionGeneration),
          count: (group.memberIds ?? []).length,
        },
      }
    })
    dropTargets.current = groups
    setNodes([...imageNodes, ...groups])
    const placedIds = new Set(placed.map((image) => image.id))
    setEdges(
      (data.relationships ?? [])
        .filter(
          (relationship) =>
            placedIds.has(relationship.sourceImageId) &&
            placedIds.has(relationship.derivedImageId)
        )
        .flatMap((relationship) => {
          const source =
              groupByImage.get(relationship.sourceImageId) ??
              String(relationship.sourceImageId),
            edgeTarget =
              groupByImage.get(relationship.derivedImageId) ??
              String(relationship.derivedImageId)
          return source === edgeTarget
            ? []
            : [
                {
                  id: String(relationship.id),
                  source,
                  target: edgeTarget,
                  reconnectable: false,
                },
              ]
        })
    )
  }, [
    data,
    expanded,
    repoPath,
    renditionGeneration,
    callbacks,
    dropTargets,
    setEdges,
    setNodes,
  ])

  const resolveSetDropTarget = useCallback(
    (node: Node) => {
      const nodeWidth = node.measured?.width ?? node.width ?? 150
      const nodeHeight = node.measured?.height ?? node.height ?? 110
      return (
        dropTargets.current.find((candidate) => {
          const groupWidth = candidate.measured?.width ?? candidate.width ?? 160
          const groupHeight =
            candidate.measured?.height ?? candidate.height ?? 128
          return (
            node.position.x < candidate.position.x + groupWidth &&
            node.position.x + nodeWidth > candidate.position.x &&
            node.position.y < candidate.position.y + groupHeight &&
            node.position.y + nodeHeight > candidate.position.y
          )
        }) ?? null
      )
    },
    [dropTargets]
  )

  const isCanvasNodeSelected = useCallback(
    (node: Node) => {
      if (selection.surface !== 'canvas') return false
      if (node.type !== 'group') return selectedImageIds.has(Number(node.id))
      const groupId = Number(node.id.slice(4))
      if (selection.group === groupId) return true
      const members = groupMemberMap.get(groupId)
      if (!members) return false
      let placedCount = 0
      for (const id of members) {
        if (!placedImageIds.has(id)) continue
        placedCount += 1
        if (!selectedImageIds.has(id)) return false
      }
      return placedCount > 0
    },
    [
      selection.surface,
      selection.group,
      selectedImageIds,
      placedImageIds,
      groupMemberMap,
    ]
  )
  const displayNodes = useMemo(() => {
    const mapped = nodes.map((node) => {
      const selected = isCanvasNodeSelected(node)
      const className =
        target?.id === node.id
          ? target.valid
            ? 'ring-4 ring-green-500'
            : 'ring-4 ring-red-500'
          : ''
      const zIndex = node.id === hoveredNodeId ? 1001 : node.zIndex
      const previous = previousDisplayNodes.current.get(node.id)
      if (
        previous &&
        previous.data === node.data &&
        previous.position === node.position &&
        previous.measured === node.measured &&
        previous.width === node.width &&
        previous.height === node.height &&
        previous.selected === selected &&
        previous.className === className &&
        previous.dragging === node.dragging &&
        previous.zIndex === zIndex
      )
        return previous
      return { ...node, selected, className, zIndex }
    })
    previousDisplayNodes.current = new Map(
      mapped.map((node) => [node.id, node])
    )
    return mapped
  }, [nodes, isCanvasNodeSelected, target, hoveredNodeId])
  const displayEdges: Edge[] = useMemo(
    () =>
      edges.map((edge) => {
        const selected =
          selection.surface === 'canvas' &&
          selection.edges.includes(Number(edge.id))
        const color = selected ? 'var(--color-ink)' : 'var(--color-primary)'
        return {
          ...edge,
          selected,
          style: { stroke: color, strokeWidth: selected ? 3 : 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color },
        }
      }),
    [edges, selection.surface, selection.edges]
  )
  const selectedCanvasNodeIds = useMemo(() => {
    if (selection.surface !== 'canvas') return []
    const placedIds = new Set(
      (data.images ?? [])
        .filter((image) => image.placed && !image.trashed)
        .map((image) => image.id)
    )
    const collapsedGroups = (data.groups ?? []).filter(
      (group) =>
        group.id !== expanded &&
        (group.memberIds ?? []).some((id) => placedIds.has(id))
    )
    const groupedImageIds = new Set(
      collapsedGroups.flatMap((group) => group.memberIds ?? [])
    )
    const selected = selection.ids
      .filter((id) => placedIds.has(id) && !groupedImageIds.has(id))
      .map(String)
    for (const group of collapsedGroups) {
      const members = (group.memberIds ?? []).filter((id) => placedIds.has(id))
      if (
        selection.group === group.id ||
        (members.length > 0 && members.every((id) => selectedImageIds.has(id)))
      )
        selected.push(`set-${group.id}`)
    }
    return selected
  }, [
    data.groups,
    data.images,
    expanded,
    selectedImageIds,
    selection.group,
    selection.surface,
    selection.ids,
  ])

  return {
    selectedIdsList,
    isCanvasNodeSelected,
    displayNodes,
    displayEdges,
    selectedCanvasNodeIds,
    resolveSetDropTarget,
    setHoveredNodeId,
  }
}
