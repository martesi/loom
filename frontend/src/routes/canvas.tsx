import { Dialog } from '@base-ui-components/react/dialog'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  type Edge,
  MarkerType,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
} from '@xyflow/react'
import { PanelLeft, PanelRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import '@xyflow/react/dist/style.css'
import {
  type CanvasData,
  GroupService,
  ImageService,
  type RepoInfo,
} from '../../bindings/loom/internal/service'
import { CanvasDock } from '../components/canvas/canvas-dock'
import { DetailPanel } from '../components/canvas/detail-panel'
import { GroupNode } from '../components/canvas/group-node'
import { ImageNode } from '../components/canvas/image-node'
import { LibraryPanel } from '../components/canvas/library-panel'
import { LightboxViewer } from '../components/canvas/lightbox'
import { RepoSelect } from '../components/canvas/repo-select'
import { SelectionHud } from '../components/canvas/selection-hud'
import { ShelfPanel } from '../components/canvas/shelf-panel'
import { CompressionDialog } from '../components/compression-dialog'
import { type MenuAction, PositionedMenu } from '../components/menu'
import { Button } from '../components/ui/button'
import { copyMedia, filesToMedia, readMedia } from '../lib/clipboard'
import { computeSubgraphLayout, placeCluster } from '../lib/layout'
import { emptySelection, type Selection } from '../lib/selection'
import { useGroupShortcut, useUndoShortcuts } from '../lib/use-undo'
import { cn } from '../lib/utils'

const nodeTypes = { image: ImageNode, group: GroupNode }
const RELATION_DRAG_THRESHOLD = 5
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
  const [data, setData] = useState<CanvasData>({
    images: [],
    relationships: [],
    groups: [],
  })
  const [nodes, setNodes] = useState<Node[]>([]),
    [edges, setEdges] = useState<Edge[]>([])
  const [selection, setSelection] = useState<Selection>(emptySelection),
    [expanded, setExpanded] = useState<number | null>(null)
  const [refresh, setRefresh] = useState(0),
    [error, setError] = useState(''),
    [space, setSpace] = useState(false),
    [ready, setReady] = useState(false)
  const [compressIds, setCompressIds] = useState<number[] | null>(null)
  const [purgeIds, setPurgeIds] = useState<number[] | null>(null)
  const [previewImageId, setPreviewImageId] = useState<number | null>(null)
  const [assetsOpen, setAssetsOpen] = useState(
    () =>
      typeof window === 'undefined' ||
      !window.matchMedia('(max-width: 1099px)').matches
  )
  const [inspectorOpen, setInspectorOpen] = useState(
    () =>
      typeof window === 'undefined' ||
      !window.matchMedia('(max-width: 1099px)').matches
  )

  useEffect(() => {
    const compact = window.matchMedia('(max-width: 1099px)')
    const sync = (event: MediaQueryListEvent) => {
      setAssetsOpen(!event.matches)
      setInspectorOpen(!event.matches)
    }
    compact.addEventListener('change', sync)
    return () => compact.removeEventListener('change', sync)
  }, [])
  const [menu, setMenu] = useState<{
    kind: 'pane' | 'node' | 'selection'
    x: number
    y: number
    nodeId?: string
  } | null>(null)
  const [reveal, setReveal] = useState<{
    id: number
    folder: string | null
  } | null>(null)
  const visible = useRef<number[]>([]),
    relation = useRef<{ source: number; x: number; y: number } | null>(null)
  const [relationshipPreview, setRelationshipPreview] = useState<{
    x1: number
    y1: number
    x2: number
    y2: number
    valid: boolean | null
  } | null>(null)
  const [target, setTarget] = useState<{
    id: string
    valid: boolean
    kind: 'relationship' | 'set'
  } | null>(null)
  const report = (e: unknown) => {
    console.error('canvas operation failed', e)
    setError(e instanceof Error ? e.message : String(e))
  }
  const callbacks = useRef({ report, run, selectAssets })
  callbacks.current = { report, run, selectAssets }
  async function reload() {
    const result = await ImageService.LoadCanvas(repo.path)
    if (result) setData(result)
    setRefresh((n) => n + 1)
  }
  function run(action: () => Promise<unknown>) {
    void action().then(reload).catch(report)
  }
  useEffect(() => {
    void Promise.all([
      ImageService.LoadCanvas(repo.path),
      ImageService.GetViewport(repo.path),
    ])
      .then(([d, v]) => {
        if (d) setData(d)
        setRefresh((n) => n + 1)
        if (v) void flow.setViewport(v)
        setReady(true)
        if (
          !v &&
          (d?.images ?? []).some((image) => image.placed && !image.trashed)
        )
          setTimeout(() => void flow.fitView({ padding: 0.2, maxZoom: 1 }), 100)
      })
      .catch(callbacks.current.report)
  }, [repo.path, flow])
  useEffect(() => {
    const placed = (data.images ?? []).filter((i) => i.placed && !i.trashed)
    const collapsed = (data.groups ?? []).filter(
      (g) =>
        g.id !== expanded &&
        (g.memberIds ?? []).some((id) => placed.some((i) => i.id === id))
    )
    const groupByImage = new Map(
      collapsed.flatMap((g) =>
        (g.memberIds ?? []).map((id) => [id, `set-${g.id}`] as const)
      )
    )
    const imageNodes: Node[] = placed
      .filter((i) => !groupByImage.has(i.id))
      .map((i) => ({
        id: String(i.id),
        type: 'image',
        position: { x: i.canvasX, y: i.canvasY },
        width: i.canvasW || 150,
        height: i.canvasH || 110,
        data: {
          fileName: i.fileName,
          thumbUrl: i.thumbUrl,
          missing: i.missing,
          showFileName: true,
          width: i.width,
          height: i.height,
          onResizeEnd: (x: number, y: number, w: number, h: number) =>
            callbacks.current.run(async () => {
              await ImageService.SetPosition(repo.path, i.id, x, y)
              await ImageService.SetSize(repo.path, i.id, w, h)
            }),
        },
      }))
    const groups: Node[] = collapsed.map((g) => {
      const members = placed.filter((i) => (g.memberIds ?? []).includes(i.id))
      const cover = members.find((i) => i.id === g.coverImageId) ?? members[0]
      return {
        id: `set-${g.id}`,
        type: 'group',
        position: {
          x: Math.min(...members.map((i) => i.canvasX)),
          y: Math.min(...members.map((i) => i.canvasY)),
        },
        width: 160,
        height: 128,
        data: {
          name: g.name || cover.fileName,
          thumbUrl: cover.thumbUrl,
          count: (g.memberIds ?? []).length,
        },
      }
    })
    setNodes([...imageNodes, ...groups])
    const placedIds = new Set(placed.map((i) => i.id))
    setEdges(
      (data.relationships ?? [])
        .filter(
          (r) =>
            placedIds.has(r.sourceImageId) && placedIds.has(r.derivedImageId)
        )
        .flatMap((r) => {
          const source =
              groupByImage.get(r.sourceImageId) ?? String(r.sourceImageId),
            target =
              groupByImage.get(r.derivedImageId) ?? String(r.derivedImageId)
          return source === target
            ? []
            : [{ id: String(r.id), source, target, reconnectable: false }]
        })
    )
  }, [data, expanded, repo.path])
  function isCanvasNodeSelected(node: Node) {
    if (selection.surface !== 'canvas') return false
    if (node.type !== 'group') return selection.ids.includes(Number(node.id))
    const groupId = Number(node.id.slice(4))
    const members = groupMembers(groupId).filter((id) =>
      (data.images ?? []).some(
        (image) => image.id === id && image.placed && !image.trashed
      )
    )
    return (
      selection.group === groupId ||
      (members.length > 0 && members.every((id) => selection.ids.includes(id)))
    )
  }
  const displayNodes = nodes.map((n) => ({
    ...n,
    selected: isCanvasNodeSelected(n),
    className:
      target?.id === n.id
        ? target.valid
          ? 'ring-4 ring-green-500'
          : 'ring-4 ring-red-500'
        : '',
  }))
  const displayEdges: Edge[] = edges.map((e) => {
    const selected =
      selection.surface === 'canvas' && selection.edges.includes(Number(e.id))
    const color = selected ? 'var(--color-ink)' : 'var(--color-primary)'
    return {
      ...e,
      selected,
      style: { stroke: color, strokeWidth: selected ? 3 : 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color },
    }
  })
  function center() {
    const b = host.current?.getBoundingClientRect()
    return flow.screenToFlowPosition({
      x: (b?.left ?? 0) + (b?.width ?? 800) / 2,
      y: (b?.top ?? 0) + (b?.height ?? 600) / 2,
    })
  }
  function selectAssets(ids: number[]) {
    setExpanded(null)
    setSelection({ surface: 'assets', ids, edges: [], group: null })
  }
  function groupMembers(id: number) {
    return data.groups?.find((g) => g.id === id)?.memberIds ?? []
  }
  function selectedIds() {
    return [
      ...new Set([
        ...selection.ids,
        ...(selection.group ? groupMembers(selection.group) : []),
      ]),
    ]
  }
  async function removeCanvasAssets(ids: number[], trash: boolean) {
    if (trash)
      await Promise.all(ids.map((id) => ImageService.TrashImage(repo.path, id)))
    else await ImageService.UnplaceImages(repo.path, ids)
    setSelection((current) => {
      if (current.surface !== 'canvas') return current
      return {
        ...current,
        ids: current.ids.filter((id) => !ids.includes(id)),
        group:
          current.group &&
          groupMembers(current.group).some((id) => ids.includes(id))
            ? null
            : current.group,
      }
    })
  }
  const canCreateSet =
    selection.surface === 'canvas' &&
    selection.group === null &&
    selection.ids.length >= 2 &&
    selection.ids.every(
      (id) => !(data.images ?? []).find((image) => image.id === id)?.groupId
    )
  async function createSet() {
    if (!canCreateSet) return
    await GroupService.CreateGroup(repo.path, '', '', selection.ids)
    setSelection(emptySelection)
    await reload()
  }
  useUndoShortcuts(repo.path, reload)
  useGroupShortcut(canCreateSet, () => {
    void createSet().catch(report)
  })
  async function go(id: number, folder = false) {
    const image = await ImageService.GetImage(repo.path, id)
    if (!image) return
    if (folder || !image.placed) {
      selectAssets([id])
      setReveal({
        id,
        folder: folder
          ? image.filePath
              .slice(repo.path.length + 1)
              .split('/')
              .slice(0, -1)
              .join('/')
          : null,
      })
      return
    }
    setExpanded(image.groupId || null)
    setSelection({ surface: 'canvas', ids: [id], edges: [], group: null })
    await flow.setCenter(image.canvasX + 75, image.canvasY + 55, {
      zoom: flow.getZoom(),
    })
  }
  async function paste(
    media?: Awaited<ReturnType<typeof readMedia>>,
    surface = selection.surface
  ) {
    const point = center()
    const assets = media ?? (await readMedia())
    const canvas = surface === 'canvas'
    const ids = await ImageService.ImportMedia(
      repo.path,
      assets,
      canvas,
      point.x,
      point.y
    )
    await reload()
    setSelection({
      surface: canvas ? 'canvas' : 'assets',
      ids: ids ?? [],
      edges: [],
      group: null,
    })
    if (!canvas && ids?.length) setReveal({ id: ids[0], folder: null })
  }
  async function remove(purge: boolean) {
    const ids = selectedIds()
    if (purge) {
      if (ids.length) setPurgeIds(ids)
      return
    } else if (selection.surface === 'assets') {
      for (const id of ids) await ImageService.TrashImage(repo.path, id)
    } else {
      await ImageService.UnplaceImages(repo.path, ids)
      for (const id of selection.edges)
        await ImageService.UnlinkSource(repo.path, id)
    }
    setSelection({ ...selection, ids: [], edges: [], group: null })
    await reload()
  }
  async function confirmPurge() {
    if (!purgeIds?.length) return
    await ImageService.PurgeImages(repo.path, purgeIds)
    setPurgeIds(null)
    setSelection({ ...selection, ids: [], edges: [], group: null })
    await reload()
  }
  const latest = useRef({
    selection,
    selectedIds,
    remove,
    paste,
    displayNodes,
    center,
    arrange,
    flow,
  })
  latest.current = {
    selection,
    selectedIds,
    remove,
    paste,
    displayNodes,
    center,
    arrange,
    flow,
  }
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLElement &&
        e.target.closest('input,textarea,select,[contenteditable=true]')
      )
        return
      if (e.code === 'Space') {
        e.preventDefault()
        setSpace(true)
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        void latest.current.remove(e.shiftKey).catch(callbacks.current.report)
      }
      if (e.shiftKey && !(e.ctrlKey || e.metaKey)) {
        if (e.key === '1' || e.key === '!' || e.code === 'Digit1') {
          e.preventDefault()
          void latest.current.flow
            .fitView({ padding: 0.2 })
            .then(() =>
              ImageService.SetViewport(
                repo.path,
                latest.current.flow.getViewport()
              )
            )
            .catch(callbacks.current.report)
          return
        }
        if (e.key === '2' || e.key === '@' || e.code === 'Digit2') {
          e.preventDefault()
          const selected = latest.current.displayNodes.filter((n) => n.selected)
          if (selected.length > 0) {
            void latest.current.flow
              .fitView({ nodes: selected, padding: 0.2 })
              .then(() =>
                ImageService.SetViewport(
                  repo.path,
                  latest.current.flow.getViewport()
                )
              )
              .catch(callbacks.current.report)
          }
          return
        }
        if (e.key.toLowerCase() === 'a') {
          e.preventDefault()
          const selected = latest.current.displayNodes.filter((n) => n.selected)
          if (selected.length >= 2) {
            void latest.current
              .arrange(selected.map((n) => n.id))
              .catch(callbacks.current.report)
          } else {
            void latest.current.arrange().catch(callbacks.current.report)
          }
          return
        }
      }
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setAssetsOpen((prev) => !prev)
        return
      }
      if (e.key.toLowerCase() === 'i') {
        e.preventDefault()
        setInspectorOpen((prev) => !prev)
        return
      }
      if (e.key === '0' || e.code === 'Digit0') {
        e.preventDefault()
        const p = latest.current.center()
        void latest.current.flow
          .setCenter(p.x, p.y, { zoom: 1 })
          .then(() =>
            ImageService.SetViewport(
              repo.path,
              latest.current.flow.getViewport()
            )
          )
          .catch(callbacks.current.report)
        return
      }
      if (e.key.toLowerCase() === 'a') {
        e.preventDefault()
        if (latest.current.selection.surface === 'assets')
          callbacks.current.selectAssets(visible.current)
        else
          setSelection({
            surface: 'canvas',
            ids: (data.images ?? [])
              .filter((i) => i.placed && !i.trashed)
              .map((i) => i.id),
            edges: [],
            group: null,
          })
      }
      if (e.key.toLowerCase() === 'c') {
        e.preventDefault()
        void copyMedia(
          repo.path,
          latest.current.selectedIds(),
          e.shiftKey
        ).catch(callbacks.current.report)
      }
      if (e.key.toLowerCase() === 'v') {
        e.preventDefault()
        void latest.current.paste().catch(callbacks.current.report)
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpace(false)
    }
    const blur = () => setSpace(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [repo.path, data])
  function targetAt(x: number, y: number) {
    return (
      document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>('.react-flow__node')
        ?.getAttribute('data-id') ?? null
    )
  }
  function isRelationshipDrag(
    drag: { x: number; y: number },
    x: number,
    y: number
  ) {
    return Math.hypot(x - drag.x, y - drag.y) >= RELATION_DRAG_THRESHOLD
  }
  function validTarget(source: number, id: string) {
    const targets = id.startsWith('set-')
      ? groupMembers(Number(id.slice(4)))
      : [Number(id)]
    return targets.every((t) => {
      const seen = new Set<number>()
      const stack = [t]
      while (stack.length) {
        const next = stack.pop()
        if (next === undefined) break
        if (next === source) return false
        if (seen.has(next)) continue
        seen.add(next)
        stack.push(
          ...(data.relationships ?? [])
            .filter((r) => r.sourceImageId === next)
            .map((r) => r.derivedImageId)
        )
      }
      return true
    })
  }
  async function arrange(nodeIds = nodes.map((node) => node.id)) {
    const clusterNodes = nodes.filter((node) => nodeIds.includes(node.id))
    if (!clusterNodes.length) return
    const positions = computeSubgraphLayout(
      clusterNodes.map((node) => ({
        id: node.id,
        width: node.width ?? node.measured?.width ?? 150,
        height: node.height ?? node.measured?.height ?? 110,
      })),
      edges.map((edge) => ({ source: edge.source, target: edge.target }))
    )
    const existing = nodes
      .filter((node) => !nodeIds.includes(node.id))
      .map((node) => ({
        id: node.id,
        ...node.position,
        width: node.width ?? node.measured?.width ?? 150,
        height: node.height ?? node.measured?.height ?? 110,
      }))
    const minX = Math.min(...clusterNodes.map((node) => node.position.x))
    const minY = Math.min(...clusterNodes.map((node) => node.position.y))
    const placed = existing.length
      ? placeCluster(positions, existing)
      : new Map(
          [...positions].map(([id, position]) => [
            id,
            { x: position.x + minX, y: position.y + minY },
          ])
        )
    const updates = [...placed].flatMap(([id, position]) => {
      const node = nodes.find((candidate) => candidate.id === id)
      if (!node) return []
      if (node.type !== 'group') return [{ imageId: Number(id), ...position }]
      const group = (data.groups ?? []).find((g) => `set-${g.id}` === id)
      if (!group) return []
      const dx = position.x - node.position.x
      const dy = position.y - node.position.y
      return (data.images ?? [])
        .filter(
          (image) => (group.memberIds ?? []).includes(image.id) && image.placed
        )
        .map((image) => ({
          imageId: image.id,
          x: image.canvasX + dx,
          y: image.canvasY + dy,
        }))
    })
    await ImageService.SetPositions(repo.path, updates)
    await reload()
  }
  const selectedCanvasNodeIds = displayNodes
    .filter((node) => node.selected)
    .map((node) => node.id)
  async function alignHorizontal() {
    const selected = displayNodes.filter((n) => n.selected)
    if (selected.length < 2) return
    const avgY = Math.round(
      selected.reduce((sum, n) => sum + n.position.y, 0) / selected.length
    )
    const updates = selected.flatMap((n) => {
      if (n.type === 'group') {
        const group = (data.groups ?? []).find((g) => `set-${g.id}` === n.id)
        if (!group) return []
        const members = (data.images ?? []).filter(
          (i) => (group.memberIds ?? []).includes(i.id) && i.placed
        )
        const dy = avgY - n.position.y
        return members.map((i) => ({
          imageId: i.id,
          x: i.canvasX,
          y: i.canvasY + dy,
        }))
      }
      return [{ imageId: Number(n.id), x: n.position.x, y: avgY }]
    })
    await ImageService.SetPositions(repo.path, updates)
    await reload()
  }
  async function alignVertical() {
    const selected = displayNodes.filter((n) => n.selected)
    if (selected.length < 2) return
    const avgX = Math.round(
      selected.reduce((sum, n) => sum + n.position.x, 0) / selected.length
    )
    const updates = selected.flatMap((n) => {
      if (n.type === 'group') {
        const group = (data.groups ?? []).find((g) => `set-${g.id}` === n.id)
        if (!group) return []
        const members = (data.images ?? []).filter(
          (i) => (group.memberIds ?? []).includes(i.id) && i.placed
        )
        const dx = avgX - n.position.x
        return members.map((i) => ({
          imageId: i.id,
          x: i.canvasX + dx,
          y: i.canvasY,
        }))
      }
      return [{ imageId: Number(n.id), x: avgX, y: n.position.y }]
    })
    await ImageService.SetPositions(repo.path, updates)
    await reload()
  }
  function handleLocate(node: Node) {
    if (node.type === 'group') {
      const groupId = Number(node.id.slice(4))
      const members = groupMembers(groupId)
      selectAssets(members)
      if (members.length) setReveal({ id: members[0], folder: null })
    } else {
      const imageId = Number(node.id)
      selectAssets([imageId])
      setReveal({ id: imageId, folder: null })
    }
    void flow
      .setCenter(
        node.position.x + (node.measured?.width ?? node.width ?? 150) / 2,
        node.position.y + (node.measured?.height ?? node.height ?? 110) / 2,
        { zoom: flow.getZoom() }
      )
      .catch(report)
  }
  function handlePreview(node: Node) {
    if (node.type === 'group') {
      const groupId = Number(node.id.slice(4))
      const group = (data.groups ?? []).find((g) => g.id === groupId)
      const firstId = group?.coverImageId ?? group?.memberIds?.[0]
      if (firstId) setPreviewImageId(firstId)
    } else {
      setPreviewImageId(Number(node.id))
    }
  }
  function handleUnplace(nodeIds: string[]) {
    const idsToUnplace = nodeIds.flatMap((id) => {
      if (id.startsWith('set-')) {
        return groupMembers(Number(id.slice(4)))
      }
      return [Number(id)]
    })
    run(() => removeCanvasAssets(idsToUnplace, false))
  }
  const menuItems: MenuAction[] = (() => {
    if (!menu) return []
    if (menu.kind === 'pane')
      return [
        {
          key: 'select-all',
          label: t`Select all`,
          disabled: displayNodes.length === 0,
          onSelect: () =>
            setSelection({
              surface: 'canvas',
              ids: (data.images ?? [])
                .filter((image) => image.placed && !image.trashed)
                .map((image) => image.id),
              edges: [],
              group: null,
            }),
        },
        {
          key: 'auto-arrange',
          label: t`Auto-arrange canvas`,
          disabled: displayNodes.length < 2,
          onSelect: () => run(() => arrange()),
        },
      ]
    if (menu.kind === 'selection') {
      const ids = selectedIds()
      return [
        {
          key: 'create-set',
          label: t`Create set`,
          disabled: !canCreateSet,
          onSelect: () => void createSet().catch(report),
        },
        {
          key: 'auto-arrange-selection',
          label: t`Auto-arrange selection`,
          onSelect: () => run(() => arrange(selectedCanvasNodeIds)),
        },
        {
          key: 'remove',
          label: t`Remove from canvas`,
          separatorBefore: true,
          onSelect: () => run(() => removeCanvasAssets(ids, false)),
        },
        {
          key: 'trash',
          label: t`Trash selection`,
          danger: true,
          onSelect: () => run(() => removeCanvasAssets(ids, true)),
        },
      ]
    }
    const nodeId = menu.nodeId
    if (!nodeId) return []
    if (nodeId.startsWith('set-')) {
      const groupId = Number(nodeId.slice(4))
      return [
        {
          key: 'dissolve-set',
          label: t`Dissolve set`,
          onSelect: () => run(() => GroupService.Ungroup(repo.path, groupId)),
        },
      ]
    }
    const imageId = Number(nodeId)
    const image = (data.images ?? []).find(
      (candidate) => candidate.id === imageId
    )
    if (!image) return []
    return [
      {
        key: 'find-assets',
        label: t`Find in assets`,
        onSelect: () => {
          selectAssets([imageId])
          setReveal({ id: imageId, folder: null })
        },
      },
      {
        key: 'remove',
        label: t`Remove from canvas`,
        separatorBefore: true,
        onSelect: () => run(() => removeCanvasAssets([imageId], false)),
      },
      {
        key: 'archive',
        label: image.archived ? t`Unarchive` : t`Archive`,
        onSelect: () =>
          run(() =>
            ImageService.SetArchived(repo.path, imageId, !image.archived)
          ),
      },
      {
        key: 'trash',
        label: t`Trash`,
        danger: true,
        onSelect: () => run(() => removeCanvasAssets([imageId], true)),
      },
    ]
  })()
  const toolbar = (
    label: string,
    action: () => Promise<unknown>,
    disabled = false
  ) => (
    <Button
      variant="secondary"
      size="sm"
      disabled={disabled}
      onClick={() => void action().catch(report)}
    >
      {label}
    </Button>
  )
  return (
    <div className="flex h-screen flex-col bg-surface-canvas text-ink">
      <header className="flex items-center gap-2 border-b border-black/10 bg-card px-3 py-2 text-xs">
        <button
          type="button"
          aria-label={t`Assets`}
          aria-expanded={assetsOpen}
          title={t`Toggle Assets shelf (Cmd+B)`}
          data-testid="toggle-assets-shelf"
          onClick={() => setAssetsOpen((v) => !v)}
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center rounded-sm border transition-colors focus-visible:ring-2 focus-visible:ring-primary/40',
            assetsOpen
              ? 'border-black/20 bg-black/[0.06] text-ink'
              : 'border-black/16 bg-transparent text-ink/70 hover:bg-black/[0.03] hover:text-ink'
          )}
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <RepoSelect repo={repo} />
        <h1 className="text-xs font-semibold">
          <Trans>Canvas</Trans>
        </h1>
        {toolbar(t`Rescan`, reload)}
        <label className="inline-flex h-8 cursor-pointer items-center justify-center rounded-sm border border-black/16 px-3 text-xs font-semibold text-ink transition-colors hover:bg-black/[0.03] focus-within:ring-2 focus-within:ring-primary/40">
          <Trans>Import</Trans>
          <input
            type="file"
            multiple
            accept="image/*,video/*"
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              void filesToMedia(files)
                .then((media) => paste(media, 'assets'))
                .catch(report)
              e.target.value = ''
            }}
          />
        </label>
        <div className="flex-1" />
        <button
          type="button"
          aria-label={t`Inspector`}
          aria-expanded={inspectorOpen}
          title={t`Toggle Inspector shelf (Cmd+I)`}
          data-testid="toggle-inspector-shelf"
          onClick={() => setInspectorOpen((v) => !v)}
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center rounded-sm border transition-colors focus-visible:ring-2 focus-visible:ring-primary/40',
            inspectorOpen
              ? 'border-black/20 bg-black/[0.06] text-ink'
              : 'border-black/16 bg-transparent text-ink/70 hover:bg-black/[0.03] hover:text-ink'
          )}
        >
          <PanelRight className="h-4 w-4" />
        </button>
      </header>
      {error && (
        <div role="alert" className="bg-red-100 p-2 text-sm">
          {error}
          <button type="button" onClick={() => setError('')}>
            <Trans>Dismiss</Trans>
          </button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        <ShelfPanel
          title={t`Assets`}
          side="left"
          open={assetsOpen}
          onOpenChange={setAssetsOpen}
          shortcutHint="Cmd+B"
        >
          <LibraryPanel
            path={repo.path}
            selection={selection}
            select={selectAssets}
            refresh={refresh}
            onError={report}
            visible={(ids) => {
              visible.current = ids
            }}
            reveal={reveal}
            change={reload}
            compress={setCompressIds}
          />
        </ShelfPanel>
        <main
          ref={host}
          aria-label={t`Canvas`}
          className="relative min-w-0 flex-1"
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
            if (
              (event.ctrlKey || event.metaKey) &&
              id &&
              !id.startsWith('set-')
            ) {
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
            setTarget(null)
          }}
          onPointerMove={(event) => {
            const drag = relation.current
            if (!drag) return
            if (!isRelationshipDrag(drag, event.clientX, event.clientY)) {
              setRelationshipPreview(null)
              setTarget(null)
              return
            }
            const id = targetAt(event.clientX, event.clientY)
            const valid = id ? validTarget(drag.source, id) : null
            const rect = host.current?.getBoundingClientRect()
            if (rect)
              setRelationshipPreview({
                x1: drag.x - rect.left,
                y1: drag.y - rect.top,
                x2: event.clientX - rect.left,
                y2: event.clientY - rect.top,
                valid,
              })
            setTarget(
              id
                ? {
                    id,
                    valid: valid ?? false,
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
            setTarget(null)
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
            if (id && validTarget(drag.source, id))
              run(() =>
                id.startsWith('set-')
                  ? ImageService.LinkSourceToGroup(
                      repo.path,
                      drag.source,
                      Number(id.slice(4))
                    )
                  : ImageService.LinkSource(repo.path, drag.source, Number(id))
              )
          }}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }}
          onDrop={(e) => {
            e.preventDefault()
            const raw = e.dataTransfer.getData('application/x-loom-assets')
            if (raw) {
              try {
                const ids: unknown = JSON.parse(raw)
                if (
                  !Array.isArray(ids) ||
                  !ids.every((i) => Number.isSafeInteger(i))
                )
                  throw new Error('Invalid asset drag')
                const p = flow.screenToFlowPosition({
                    x: e.clientX,
                    y: e.clientY,
                  }),
                  target = targetAt(e.clientX, e.clientY),
                  group = target?.startsWith('set-')
                    ? Number(target.slice(4))
                    : 0
                run(async () => {
                  await ImageService.PlaceImages(
                    repo.path,
                    ids,
                    p.x,
                    p.y,
                    group
                  )
                  setSelection({
                    surface: 'canvas',
                    ids: group ? [] : ids,
                    edges: [],
                    group: group || null,
                  })
                })
              } catch (error) {
                report(error)
              }
            } else
              void filesToMedia(Array.from(e.dataTransfer.files))
                .then((media) => paste(media, 'canvas'))
                .catch(report)
          }}
        >
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
                      Ctrl/Cmd-drag image → image or set to create a
                      relationship.
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
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            minZoom={0.05}
            maxZoom={4}
            nodesConnectable={false}
            edgesReconnectable={false}
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode="Shift"
            selectionOnDrag={!space}
            selectionMode={SelectionMode.Partial}
            panOnDrag={space ? [0, 1, 2] : [1, 2]}
            nodesDraggable={!space}
            onNodesChange={(changes) => {
              setNodes((n) => applyNodeChanges(changes, n))
              const selected = changes.filter((c) => c.type === 'select')
              if (selected.length)
                setSelection((s) => {
                  const hasNodeSelection =
                    s.surface === 'canvas' &&
                    (s.ids.length > 0 || s.group !== null)
                  if (!selected.some((c) => c.selected) && !hasNodeSelection)
                    return s
                  let ids = s.surface === 'canvas' ? [...s.ids] : [],
                    group = s.surface === 'canvas' ? s.group : null
                  for (const c of selected) {
                    if (c.id.startsWith('set-')) {
                      group = c.selected ? Number(c.id.slice(4)) : null
                      continue
                    }
                    ids = c.selected
                      ? [...new Set([...ids, Number(c.id)])]
                      : ids.filter((id) => id !== Number(c.id))
                  }
                  return { surface: 'canvas', ids, edges: [], group }
                })
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
              }
            }}
            onNodeDrag={(_, node) => {
              if (node.type !== 'image') return
              const group = flow
                .getIntersectingNodes(node)
                .find((candidate) => candidate.type === 'group')
              setTarget(
                group ? { id: group.id, valid: true, kind: 'set' } : null
              )
            }}
            onNodeDragStop={(_, node, moved) => {
              setTarget(null)
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
                      node.position.x -
                      Math.min(...members.map((i) => i.canvasX)),
                    dy =
                      node.position.y -
                      Math.min(...members.map((i) => i.canvasY))
                  await ImageService.SetPositions(
                    repo.path,
                    members.map((i) => ({
                      imageId: i.id,
                      x: i.canvasX + dx,
                      y: i.canvasY + dy,
                    }))
                  )
                  return
                }
                const target = flow
                  .getIntersectingNodes(node)
                  .find((n) => n.type === 'group')
                if (target) {
                  await ImageService.PlaceImages(
                    repo.path,
                    moved.map((n) => Number(n.id)),
                    node.position.x,
                    node.position.y,
                    Number(target.id.slice(4))
                  )
                  return
                }
                await ImageService.SetPositions(
                  repo.path,
                  moved
                    .filter((n) => n.type === 'image')
                    .map((n) => ({ imageId: Number(n.id), ...n.position }))
                )
              })
            }}
            onMoveEnd={(_, v) => {
              if (ready)
                void ImageService.SetViewport(repo.path, v).catch(report)
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault()
              setMenu({ kind: 'pane', x: event.clientX, y: event.clientY })
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
              {target.kind === 'set'
                ? 'Release to add or move into this set'
                : target.valid
                  ? 'Release to create relationship'
                  : 'Cannot create this relationship'}
            </div>
          )}
          {menu && menuItems.length > 0 && (
            <PositionedMenu
              x={menu.x}
              y={menu.y}
              items={menuItems}
              onClose={() => setMenu(null)}
            />
          )}
          <SelectionHud
            selectedNodes={displayNodes.filter((n) => n.selected)}
            hostRef={host}
            canCreateSet={canCreateSet}
            onCreateSet={() => void createSet().catch(report)}
            onAlignHorizontal={() => void alignHorizontal().catch(report)}
            onAlignVertical={() => void alignVertical().catch(report)}
            onArrangeSubgraph={() =>
              void arrange(selectedCanvasNodeIds).catch(report)
            }
            onUnplace={handleUnplace}
            onPreview={handlePreview}
            onLocate={handleLocate}
          />
          <CanvasDock
            canFitAll={displayNodes.length > 0}
            canFitSelection={displayNodes.some((n) => n.selected)}
            canAutoArrange={displayNodes.length >= 2}
            canCreateSet={canCreateSet}
            onFitAll={async () => {
              await flow.fitView({ padding: 0.2 })
              await ImageService.SetViewport(repo.path, flow.getViewport())
            }}
            onFitSelection={async () => {
              await flow.fitView({
                nodes: displayNodes.filter((n) => n.selected),
                padding: 0.2,
              })
              await ImageService.SetViewport(repo.path, flow.getViewport())
            }}
            onResetZoom={async () => {
              const p = center()
              await flow.setCenter(p.x, p.y, { zoom: 1 })
              await ImageService.SetViewport(repo.path, flow.getViewport())
            }}
            onAutoArrange={() => void arrange().catch(report)}
            onCreateSet={() => void createSet().catch(report)}
          />
        </main>
        <ShelfPanel
          title={t`Inspector`}
          side="right"
          open={inspectorOpen}
          onOpenChange={setInspectorOpen}
          shortcutHint="Cmd+I"
        >
          <DetailPanel
            path={repo.path}
            data={data}
            selection={selection}
            change={reload}
            go={(id, folder) => void go(id, folder).catch(report)}
            onError={report}
          />
        </ShelfPanel>
      </div>
      {previewImageId !== null && (
        <LightboxViewer
          images={(data.images ?? []).filter((i) => i.placed && !i.trashed)}
          index={Math.max(
            0,
            (data.images ?? [])
              .filter((i) => i.placed && !i.trashed)
              .findIndex((i) => i.id === previewImageId)
          )}
          onClose={() => setPreviewImageId(null)}
          onIndexChange={(idx) => {
            const placed = (data.images ?? []).filter(
              (i) => i.placed && !i.trashed
            )
            if (placed[idx]) setPreviewImageId(placed[idx].id)
          }}
          tagsForImage={() => []}
          placementLabel={
            (data.images ?? []).find((i) => i.id === previewImageId)?.placed
              ? 'Canvas'
              : 'Library'
          }
          sourcesFor={(id) =>
            (data.relationships ?? [])
              .filter((r) => r.derivedImageId === id)
              .map((r) => {
                const src = (data.images ?? []).find(
                  (i) => i.id === r.sourceImageId
                )
                return {
                  id: r.sourceImageId,
                  fileName: src?.fileName ?? '',
                  thumbUrl: src?.thumbUrl ?? '',
                }
              })
          }
          onJumpTo={(id) => {
            setPreviewImageId(id)
            void go(id).catch(report)
          }}
        />
      )}
      {compressIds && (
        <CompressionDialog
          path={repo.path}
          assetIds={compressIds}
          onClose={() => setCompressIds(null)}
          onChange={reload}
        />
      )}
      <Dialog.Root
        open={purgeIds !== null}
        onOpenChange={(open) => {
          if (!open) setPurgeIds(null)
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[1px]" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-black/8 bg-card p-5 shadow-lg outline-none">
            <Dialog.Title className="text-sm font-semibold text-ink">
              Permanently delete {purgeIds?.length ?? 0} asset
              {purgeIds?.length === 1 ? '' : 's'}?
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-xs leading-relaxed text-ink-muted">
              This removes the files and Loom metadata immediately. Trash
              retention does not apply, and this action cannot be undone.
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close render={<Button variant="secondary" size="sm" />}>
                Cancel
              </Dialog.Close>
              <Button
                variant="danger"
                size="sm"
                onClick={() => void confirmPurge().catch(report)}
              >
                Permanently delete
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
