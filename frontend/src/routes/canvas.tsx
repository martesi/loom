import { Dialog } from '@base-ui-components/react/dialog'
import { t } from '@lingui/core/macro'
import { Plural, Trans } from '@lingui/react/macro'
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
import { Command, MoreHorizontal, PanelLeft, PanelRight } from 'lucide-react'
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import '@xyflow/react/dist/style.css'
import {
  type CanvasData,
  GroupService,
  type ImageInfo,
  ImageService,
  LibraryService,
  PromptService,
  type RepoInfo,
  TagService,
} from '../../bindings/loom/internal/service'
import { CanvasDock } from '../components/canvas/canvas-dock'
import {
  CommandPalette,
  type PaletteAsset,
} from '../components/canvas/command-palette'
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
import {
  type CanvasAction,
  displayShortcut,
  isMacPlatform,
  shortcutMatches,
} from '../lib/action-catalog'
import { copyMedia, filesToMedia, readMedia } from '../lib/clipboard'
import { computeSubgraphLayout, placeCluster } from '../lib/layout'
import { emptySelection, type Selection } from '../lib/selection'
import { useUndoActions } from '../lib/use-undo'
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
  const isMac = isMacPlatform()
  const [data, setData] = useState<CanvasData>({
    images: [],
    relationships: [],
    groups: [],
  })
  const [nodes, setNodes] = useState<Node[]>([]),
    [edges, setEdges] = useState<Edge[]>([])
  const [selection, setSelection] = useState<Selection>(emptySelection),
    [expanded, setExpanded] = useState<number | null>(null)
  const [assetSelectionRecords, setAssetSelectionRecords] = useState<{
    key: string
    records: ImageInfo[]
  }>({ key: '', records: [] })
  const [refresh, setRefresh] = useState(0),
    [error, setError] = useState(''),
    [space, setSpace] = useState(false),
    [ready, setReady] = useState(false)
  const [compressIds, setCompressIds] = useState<number[] | null>(null)
  const [purgeIds, setPurgeIds] = useState<number[] | null>(null)
  const [previewImageId, setPreviewImageId] = useState<number | null>(null)
  const [assetsOpen, setAssetsOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [assetsPinned, setAssetsPinned] = useState(false)
  const [inspectorPinned, setInspectorPinned] = useState(false)
  const [focusCanvas, setFocusCanvas] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOnly, setShortcutsOnly] = useState(false)
  const [paletteInitialQuery, setPaletteInitialQuery] = useState('')
  const [recentActionIds, setRecentActionIds] = useState<string[]>([])
  const [inspectorCommandRequest, setInspectorCommandRequest] = useState<{
    command: string
    request: number
    selectionKey: string
    pending: boolean
  } | null>(null)
  const [repoMenuOpen, setRepoMenuOpen] = useState(false)
  const [searchFocusRequest, setSearchFocusRequest] = useState(0)
  const [repoOpenRequest, setRepoOpenRequest] = useState(0)
  const [navigatorModeRequest, setNavigatorModeRequest] = useState<{
    mode: 'all' | 'folders'
    request: number
  } | null>(null)
  const [paletteAssets, setPaletteAssets] = useState<PaletteAsset[]>([])
  const importInput = useRef<HTMLInputElement>(null)
  const assetsReturnFocus = useRef<HTMLElement | null>(null)
  const inspectorReturnFocus = useRef<HTMLElement | null>(null)
  const paletteReturnFocus = useRef<HTMLElement | null>(null)

  function rememberFocus(target: { current: HTMLElement | null }) {
    target.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
  }
  function openAssets() {
    if (!assetsOpen) rememberFocus(assetsReturnFocus)
    setFocusCanvas(false)
    if (window.matchMedia('(max-width: 720px)').matches) setInspectorOpen(false)
    setAssetsOpen(true)
  }
  function closeAssets(restoreFocus = true) {
    setAssetsOpen(false)
    if (restoreFocus)
      requestAnimationFrame(() => {
        if (!focusCanvas) assetsReturnFocus.current?.focus()
      })
  }
  function toggleAssets() {
    if (assetsOpen) closeAssets()
    else openAssets()
  }
  function openInspector() {
    if (!inspectorOpen) rememberFocus(inspectorReturnFocus)
    setFocusCanvas(false)
    if (window.matchMedia('(max-width: 720px)').matches) setAssetsOpen(false)
    setInspectorOpen(true)
  }
  function closeInspector(restoreFocus = true) {
    setInspectorOpen(false)
    if (restoreFocus)
      requestAnimationFrame(() => {
        if (!focusCanvas) inspectorReturnFocus.current?.focus()
      })
  }
  function toggleInspector() {
    if (inspectorOpen) closeInspector()
    else openInspector()
  }
  function requestInspectorCommand(command: string) {
    openInspector()
    setInspectorCommandRequest((current) => ({
      command,
      request: (current?.request ?? 0) + 1,
      selectionKey: `${selection.surface}:${selection.ids.join(',')}:${selection.group ?? ''}`,
      pending: true,
    }))
  }
  const handleInspectorCommandRequest = useCallback((request: number) => {
    setInspectorCommandRequest((current) =>
      current?.request === request ? { ...current, pending: false } : current
    )
  }, [])
  async function submitInspectorField(
    command: 'move-rename-file' | 'add-tag' | 'save-prompt',
    value: string,
    imageIds: number[],
    fileName?: string
  ) {
    const ids = selectedIds()
    if (
      !ids.length ||
      imageIds.length !== ids.length ||
      ids.some((id) => !imageIds.includes(id))
    )
      return
    if (command === 'move-rename-file') {
      const path = value.trim()
      if (ids.length !== 1 || !path || path === fileName) return
      await ImageService.MoveFile(repo.path, ids[0], path)
      await reload()
      return
    }
    if (command === 'add-tag') {
      const tag = value.trim()
      if (!tag) return
      await Promise.all(ids.map((id) => TagService.AddTag(repo.path, id, tag)))
      await reload()
      return
    }
    if (command === 'save-prompt') {
      await Promise.all(
        ids.map((id) =>
          PromptService.CreateAndAttachPrompt(repo.path, id, '', value, '')
        )
      )
      await reload()
    }
  }
  function openPalette(shortcuts = false, initialQuery = '') {
    rememberFocus(paletteReturnFocus)
    setShortcutsOnly(shortcuts)
    setPaletteInitialQuery(initialQuery)
    setPaletteOpen(true)
  }
  function changePaletteOpen(open: boolean) {
    setPaletteOpen(open)
    if (!open) {
      requestAnimationFrame(() => paletteReturnFocus.current?.focus())
    }
  }

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
  // Refreshes invalidate cached trash and archive state for selected assets.
  const assetSelectionKey =
    selection.surface === 'assets' && selection.ids.length
      ? `${refresh}:${selection.ids.join(',')}`
      : ''
  useEffect(() => {
    if (!assetSelectionKey) {
      setAssetSelectionRecords({ key: '', records: [] })
      return
    }
    let cancelled = false
    const ids = assetSelectionKey.split(':', 2)[1]?.split(',').map(Number) ?? []
    void Promise.all(ids.map((id) => ImageService.GetImage(repo.path, id)))
      .then((images) => {
        if (!cancelled)
          setAssetSelectionRecords({
            key: assetSelectionKey,
            records: images.filter(
              (image): image is ImageInfo => image !== null
            ),
          })
      })
      .catch(callbacks.current.report)
    return () => {
      cancelled = true
    }
  }, [assetSelectionKey, repo.path])
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
          onPreview: () => setPreviewImageId(i.id),
          onMore: (event: MouseEvent<HTMLButtonElement>) => {
            const bounds = event.currentTarget.getBoundingClientRect()
            setSelection({
              surface: 'canvas',
              ids: [i.id],
              edges: [],
              group: null,
            })
            setMenu({
              kind: 'node',
              x: event.clientX || bounds.left,
              y: event.clientY || bounds.bottom,
              nodeId: String(i.id),
            })
          },
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
    await reload()
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
  const undoActions = useUndoActions(repo.path, reload)
  async function go(id: number, folder = false) {
    const image = await ImageService.GetImage(repo.path, id)
    if (!image) return
    if (folder || !image.placed) {
      openAssets()
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
    openAssets()
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
  function handleMore(nodesToShow: Node[]) {
    const first = nodesToShow[0]
    if (!first) return
    const position = flow.flowToScreenPosition(first.position)
    setMenu({
      kind: nodesToShow.length > 1 ? 'selection' : 'node',
      x: position.x,
      y: position.y,
      nodeId: nodesToShow.length === 1 ? first.id : undefined,
    })
  }
  async function fitAll() {
    await flow.fitView({ padding: 0.2 })
    await ImageService.SetViewport(repo.path, flow.getViewport())
  }
  async function fitSelection() {
    await flow.fitView({
      nodes: nodes.filter(isCanvasNodeSelected),
      padding: 0.2,
    })
    await ImageService.SetViewport(repo.path, flow.getViewport())
  }
  async function resetZoom() {
    const point = center()
    await flow.setCenter(point.x, point.y, { zoom: 1 })
    await ImageService.SetViewport(repo.path, flow.getViewport())
  }
  async function zoomBy(factor: number) {
    await flow.setViewport({
      ...flow.getViewport(),
      zoom: Math.max(0.05, Math.min(4, flow.getZoom() * factor)),
    })
    await ImageService.SetViewport(repo.path, flow.getViewport())
  }
  function toggleFocusMode() {
    setFocusCanvas((focused) => !focused)
    requestAnimationFrame(() => host.current?.focus())
  }
  const selectedImageRecords =
    selection.surface === 'assets'
      ? assetSelectionRecords.key === assetSelectionKey
        ? assetSelectionRecords.records
        : []
      : (data.images ?? []).filter((image) => selectedIds().includes(image.id))
  const selectedRelationships = (data.relationships ?? []).filter(
    (relationship) => selection.edges.includes(relationship.id)
  )
  const singleImageRelations =
    selectedImageRecords.length === 1
      ? (data.relationships ?? []).filter(
          (relationship) =>
            relationship.sourceImageId === selectedImageRecords[0].id ||
            relationship.derivedImageId === selectedImageRecords[0].id
        )
      : []
  const relationshipActions = selectedRelationships.length
    ? selectedRelationships
    : singleImageRelations
  const canNavigateRelationship = relationshipActions.length > 0
  const canRemoveRelationship = relationshipActions.length === 1
  const canFitSelection = displayNodes.some((node) => node.selected)
  const canArrangeSelection = selectedCanvasNodeIds.length > 0
  const actionCatalog: CanvasAction[] = [
    {
      id: 'open-assets',
      label: t`Open Assets`,
      description: t`Show the repository asset navigator`,
      category: t`Workspace`,
      aliases: ['library', 'asset shelf'],
      context: t`Workspace`,
      enabled: true,
      execute: openAssets,
    },
    {
      id: 'toggle-assets',
      label: t`Toggle Assets`,
      description: t`Open or close the Assets navigator`,
      category: t`Workspace`,
      aliases: ['assets drawer'],
      shortcut: 'Mod+B',
      context: t`Workspace`,
      enabled: true,
      execute: toggleAssets,
    },
    {
      id: 'close-assets',
      label: t`Close Assets`,
      description: t`Close the Assets navigator`,
      category: t`Workspace`,
      aliases: ['hide assets'],
      context: t`Workspace`,
      enabled: assetsOpen,
      disabledReason: t`Assets is already closed`,
      execute: closeAssets,
    },
    {
      id: 'pin-assets',
      label: t`Pin Assets drawer`,
      description: t`Keep Assets open during Canvas interactions`,
      category: t`Workspace`,
      aliases: ['keep assets open'],
      context: t`Assets`,
      enabled: assetsOpen && !assetsPinned,
      disabledReason: t`Open Assets before pinning`,
      execute: () => setAssetsPinned(true),
    },
    {
      id: 'unpin-assets',
      label: t`Unpin Assets drawer`,
      description: t`Allow Assets to close after an action`,
      category: t`Workspace`,
      aliases: ['unpin assets'],
      context: t`Assets`,
      enabled: assetsOpen && assetsPinned,
      disabledReason: t`Assets is not pinned`,
      execute: () => setAssetsPinned(false),
    },
    {
      id: 'open-inspector',
      label: t`Open Inspector`,
      description: t`Show metadata for the active selection`,
      category: t`Workspace`,
      aliases: ['details', 'inspector shelf'],
      context: t`Workspace`,
      enabled: true,
      execute: openInspector,
    },
    {
      id: 'toggle-inspector',
      label: t`Toggle Inspector`,
      description: t`Open or close the Inspector`,
      category: t`Workspace`,
      aliases: ['inspector drawer'],
      shortcut: 'Mod+I',
      context: t`Workspace`,
      enabled: true,
      execute: toggleInspector,
    },
    {
      id: 'close-inspector',
      label: t`Close Inspector`,
      description: t`Close the Inspector drawer`,
      category: t`Workspace`,
      aliases: ['hide inspector'],
      context: t`Workspace`,
      enabled: inspectorOpen,
      disabledReason: t`Inspector is already closed`,
      execute: closeInspector,
    },
    {
      id: 'pin-inspector',
      label: t`Pin Inspector drawer`,
      description: t`Keep Inspector open during Canvas interactions`,
      category: t`Workspace`,
      aliases: ['keep inspector open'],
      context: t`Inspector`,
      enabled: inspectorOpen && !inspectorPinned,
      disabledReason: t`Open Inspector before pinning`,
      execute: () => setInspectorPinned(true),
    },
    {
      id: 'unpin-inspector',
      label: t`Unpin Inspector drawer`,
      description: t`Allow Inspector to close after selection clears`,
      category: t`Workspace`,
      aliases: ['unpin inspector'],
      context: t`Inspector`,
      enabled: inspectorOpen && inspectorPinned,
      disabledReason: t`Inspector is not pinned`,
      execute: () => setInspectorPinned(false),
    },
    {
      id: 'toggle-focus-canvas',
      label: t`Toggle Focus Canvas`,
      description: t`Hide or restore Canvas controls and drawers`,
      category: t`Workspace`,
      aliases: ['zen', 'focus mode'],
      shortcut: 'Mod+\\',
      context: t`Workspace`,
      enabled: true,
      execute: toggleFocusMode,
    },
    {
      id: 'show-shortcuts',
      label: t`Show keyboard shortcuts`,
      description: t`Browse available keyboard shortcuts`,
      category: t`Workspace`,
      aliases: ['help', 'shortcut reference'],
      shortcut: '?',
      context: t`Workspace`,
      enabled: true,
      execute: () => openPalette(true),
    },
    {
      id: 'show-commands',
      label: t`Show commands`,
      description: t`Search Canvas commands and repository assets`,
      category: t`Workspace`,
      aliases: ['command palette', 'search actions'],
      shortcut: 'Mod+K',
      context: t`Workspace`,
      enabled: true,
      execute: () => openPalette(false),
    },
    {
      id: 'rescan-repository',
      label: t`Rescan repository`,
      description: t`Refresh the repository asset catalog`,
      category: t`Workspace`,
      aliases: ['reload', 'refresh'],
      context: t`Workspace`,
      enabled: true,
      execute: reload,
    },
    {
      id: 'switch-repository',
      label: t`Switch repository`,
      description: t`Choose another repository window`,
      category: t`Workspace`,
      aliases: ['open repository', 'project picker'],
      context: t`Workspace`,
      enabled: true,
      execute: () => setRepoOpenRequest((request) => request + 1),
    },
    {
      id: 'import-media',
      label: t`Import media`,
      description: t`Choose images or videos to add to this repository`,
      category: t`Workspace`,
      aliases: ['add files', 'upload'],
      context: t`Workspace`,
      enabled: true,
      execute: () => importInput.current?.click(),
    },
    {
      id: 'show-all-assets',
      label: t`Show All Assets`,
      description: t`Open the semantic repository catalog`,
      category: t`Assets navigation`,
      aliases: ['catalog'],
      context: t`Assets`,
      enabled: true,
      execute: () => {
        openAssets()
        setNavigatorModeRequest((current) => ({
          mode: 'all',
          request: (current?.request ?? 0) + 1,
        }))
      },
    },
    {
      id: 'show-folders',
      label: t`Show Folders`,
      description: t`Open the physical folder navigator`,
      category: t`Assets navigation`,
      aliases: ['filesystem', 'directories'],
      context: t`Assets`,
      enabled: true,
      execute: () => {
        openAssets()
        setNavigatorModeRequest((current) => ({
          mode: 'folders',
          request: (current?.request ?? 0) + 1,
        }))
      },
    },
    {
      id: 'focus-asset-search',
      label: t`Focus asset search`,
      description: t`Open Assets and focus its search field`,
      category: t`Assets navigation`,
      aliases: ['find asset', 'search files'],
      context: t`Assets`,
      enabled: true,
      execute: () => {
        openAssets()
        setSearchFocusRequest((request) => request + 1)
      },
    },
    {
      id: 'search-assets',
      label: t`Search repository assets`,
      description: t`Search filenames, tags, and paths with @`,
      category: t`Assets navigation`,
      aliases: ['@ search', 'find media'],
      context: t`Repository`,
      enabled: true,
      execute: () => openPalette(false, '@'),
    },
    {
      id: 'fit-all',
      label: t`Fit all`,
      description: t`Frame every placed item in the Canvas`,
      category: t`Canvas view`,
      aliases: ['zoom extents', 'frame canvas'],
      shortcut: 'Shift+1',
      context: t`Canvas`,
      enabled: displayNodes.length > 0,
      disabledReason: t`There are no placed items`,
      execute: fitAll,
    },
    {
      id: 'fit-selection',
      label: t`Fit selection`,
      description: t`Frame the selected Canvas items`,
      category: t`Canvas view`,
      aliases: ['zoom to selection', 'selection bounds'],
      shortcut: 'Shift+2',
      context: t`Canvas selection`,
      enabled: canFitSelection,
      disabledReason: t`Select a Canvas item`,
      execute: fitSelection,
    },
    {
      id: 'reset-zoom',
      label: t`Reset zoom to 100%`,
      description: t`Set Canvas zoom to its original scale`,
      category: t`Canvas view`,
      aliases: ['actual size', 'zoom reset'],
      shortcut: 'Mod+0',
      context: t`Canvas`,
      enabled: true,
      execute: resetZoom,
    },
    {
      id: 'zoom-in',
      label: t`Zoom in`,
      description: t`Increase Canvas zoom`,
      category: t`Canvas view`,
      aliases: ['magnify'],
      shortcut: 'Mod+=',
      context: t`Canvas`,
      enabled: true,
      execute: () => zoomBy(1.2),
    },
    {
      id: 'zoom-out',
      label: t`Zoom out`,
      description: t`Decrease Canvas zoom`,
      category: t`Canvas view`,
      aliases: ['shrink'],
      shortcut: 'Mod+-',
      context: t`Canvas`,
      enabled: true,
      execute: () => zoomBy(1 / 1.2),
    },
    {
      id: 'auto-arrange-canvas',
      label: t`Auto-arrange Canvas`,
      description: t`Reposition all placed items using their relationships`,
      category: t`Canvas view`,
      aliases: ['layout', 'tidy all'],
      context: t`Canvas`,
      enabled: displayNodes.length > 0,
      disabledReason: t`There are no placed items`,
      execute: () => arrange(),
    },
    {
      id: 'auto-arrange-active',
      label: t`Auto-arrange Canvas or selection`,
      description: t`Arrange the selected subgraph, or the full Canvas when fewer than two items are selected`,
      category: t`Canvas view`,
      aliases: ['layout', 'tidy selection', 'tidy all'],
      shortcut: 'Shift+A',
      context: t`Canvas`,
      enabled: displayNodes.length > 0,
      disabledReason: t`There are no placed items`,
      execute: () =>
        arrange(
          selectedCanvasNodeIds.length >= 2 ? selectedCanvasNodeIds : undefined
        ),
    },
    {
      id: 'auto-arrange-selection',
      label: t`Auto-arrange selection`,
      description: t`Reposition selected items as a connected subgraph`,
      category: t`Canvas view`,
      aliases: ['arrange subgraph', 'tidy selection'],
      context: t`Canvas selection`,
      enabled: canArrangeSelection,
      disabledReason: t`Select Canvas items`,
      execute: () => arrange(selectedCanvasNodeIds),
    },
    {
      id: 'select-all',
      label: t`Select all in active surface`,
      description: t`Select all visible Assets or placed Canvas items`,
      category: t`Selection and sets`,
      aliases: ['select everything'],
      shortcut: 'Mod+A',
      context: t`Active surface`,
      enabled: visible.current.length > 0 || displayNodes.length > 0,
      disabledReason: t`There are no selectable items`,
      execute: () => {
        if (selection.surface === 'assets') selectAssets(visible.current)
        else
          setSelection({
            surface: 'canvas',
            ids: (data.images ?? [])
              .filter((image) => image.placed && !image.trashed)
              .map((image) => image.id),
            edges: [],
            group: null,
          })
      },
    },
    {
      id: 'select-all-canvas',
      label: t`Select all`,
      description: t`Select every placed Canvas item`,
      category: t`Selection and sets`,
      aliases: ['select all canvas items'],
      context: t`Canvas`,
      enabled: displayNodes.length > 0,
      disabledReason: t`There are no placed items`,
      execute: () =>
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
      id: 'clear-selection',
      label: t`Clear selection`,
      description: t`Clear the active selection`,
      category: t`Selection and sets`,
      aliases: ['deselect'],
      shortcut: 'Escape',
      context: t`Active surface`,
      enabled:
        selection.ids.length > 0 ||
        selection.edges.length > 0 ||
        !!selection.group,
      disabledReason: t`There is no active selection`,
      execute: () => setSelection(emptySelection),
    },
    {
      id: 'preview-selection',
      label: t`Preview`,
      description: t`Open the selected Canvas image in the preview viewer`,
      category: t`Selection and sets`,
      aliases: ['lightbox', 'view image'],
      context: t`Canvas selection`,
      enabled: selectedCanvasNodeIds.length === 1,
      disabledReason: t`Select one Canvas item`,
      execute: () => {
        const node = displayNodes.find((candidate) => candidate.selected)
        if (node) handlePreview(node)
      },
    },
    {
      id: 'locate-selection',
      label: t`Locate in Assets`,
      description: t`Reveal the selected Canvas item in Assets`,
      category: t`Selection and sets`,
      aliases: ['find in assets', 'show in library'],
      context: t`Canvas selection`,
      enabled: selectedCanvasNodeIds.length === 1,
      disabledReason: t`Select one Canvas item`,
      execute: () => {
        const node = displayNodes.find((candidate) => candidate.selected)
        if (node) handleLocate(node)
      },
    },
    {
      id: 'create-set',
      label: t`Create set`,
      description: t`Create a semantic set from selected Canvas items`,
      category: t`Selection and sets`,
      aliases: ['group', 'collection'],
      shortcut: 'Mod+G',
      context: t`Canvas selection`,
      enabled: canCreateSet,
      disabledReason: t`Select at least two ungrouped Canvas items`,
      execute: createSet,
    },
    {
      id: 'align-horizontal',
      label: t`Align horizontally`,
      description: t`Align selected Canvas items along one row`,
      category: t`Selection and sets`,
      aliases: ['align row'],
      context: t`Canvas selection`,
      enabled: selectedCanvasNodeIds.length > 1,
      disabledReason: t`Select at least two Canvas items`,
      execute: alignHorizontal,
    },
    {
      id: 'align-vertical',
      label: t`Align vertically`,
      description: t`Align selected Canvas items along one column`,
      category: t`Selection and sets`,
      aliases: ['align column'],
      context: t`Canvas selection`,
      enabled: selectedCanvasNodeIds.length > 1,
      disabledReason: t`Select at least two Canvas items`,
      execute: alignVertical,
    },
    {
      id: 'unplace-selection',
      label: t`Unplace selected Canvas items`,
      description: t`Remove selected nodes while keeping their assets`,
      category: t`Clipboard and lifecycle`,
      aliases: ['remove from canvas'],
      shortcut: 'Delete',
      shortcuts: ['Delete', 'Backspace'],
      context: t`Canvas selection`,
      enabled:
        selection.surface === 'canvas' &&
        (selectedIds().length > 0 || selection.edges.length > 0),
      disabledReason: t`Select Canvas items`,
      execute: () => remove(false),
    },
    {
      id: 'trash-selection',
      label: t`Trash selected Assets`,
      description: t`Move selected Assets to the repository trash`,
      category: t`Clipboard and lifecycle`,
      aliases: ['delete assets'],
      shortcut: 'Delete',
      shortcuts: ['Delete', 'Backspace'],
      context: t`Assets selection`,
      enabled: selection.surface === 'assets' && selectedIds().length > 0,
      disabledReason: t`Select Assets`,
      dangerous: true,
      execute: () => remove(false),
    },
    {
      id: 'trash-canvas-selection',
      label: t`Trash selection`,
      description: t`Move selected Canvas assets to repository trash`,
      category: t`Clipboard and lifecycle`,
      aliases: ['trash canvas items'],
      context: t`Canvas selection`,
      enabled: selection.surface === 'canvas' && selectedIds().length > 0,
      disabledReason: t`Select Canvas items`,
      dangerous: true,
      execute: () => removeCanvasAssets(selectedIds(), true),
    },
    {
      id: 'archive-selection',
      label: t`Archive`,
      description: t`Hide selected assets from the active catalog`,
      category: t`Asset metadata and file`,
      aliases: ['hide assets'],
      context: t`Assets selection`,
      enabled: selectedImageRecords.some((image) => !image.archived),
      disabledReason: t`Select an unarchived Asset`,
      execute: () =>
        Promise.all(
          selectedIds().map((id) =>
            ImageService.SetArchived(repo.path, id, true)
          )
        ).then(() => reload()),
    },
    {
      id: 'unarchive-selection',
      label: t`Unarchive`,
      description: t`Return selected assets to the active catalog`,
      category: t`Asset metadata and file`,
      aliases: ['show archived assets'],
      context: t`Assets selection`,
      enabled: selectedImageRecords.some((image) => image.archived),
      disabledReason: t`Select an archived Asset`,
      execute: () =>
        Promise.all(
          selectedIds().map((id) =>
            ImageService.SetArchived(repo.path, id, false)
          )
        ).then(() => reload()),
    },
    {
      id: 'dissolve-set',
      label: t`Dissolve set`,
      description: t`Remove the selected set while keeping its assets`,
      category: t`Selection and sets`,
      aliases: ['ungroup'],
      context: t`Set selection`,
      enabled: selection.group !== null,
      disabledReason: t`Select a set`,
      execute: () =>
        selection.group
          ? GroupService.Ungroup(repo.path, selection.group).then(() =>
              reload()
            )
          : undefined,
    },
    {
      id: 'find-in-assets',
      label: t`Find in Assets`,
      description: t`Select and reveal the active asset in Assets`,
      category: t`Assets navigation`,
      aliases: ['locate file'],
      context: t`Canvas selection`,
      enabled: selection.surface === 'canvas' && selectedIds().length > 0,
      disabledReason: t`Select a Canvas item`,
      execute: () => {
        const firstId = selectedIds()[0]
        if (firstId) {
          selectAssets([firstId])
          setReveal({ id: firstId, folder: null })
          openAssets()
        }
      },
    },
    {
      id: 'show-in-folders',
      label: t`Show in Folders`,
      description: t`Reveal the selected Asset in its physical directory`,
      category: t`Asset metadata and file`,
      aliases: ['show file location', 'browse path'],
      context: t`Asset selection`,
      enabled: selectedIds().length === 1,
      disabledReason: t`Select one Asset`,
      execute: () => {
        const id = selectedIds()[0]
        if (id) return go(id, true)
      },
    },
    {
      id: 'move-rename-file',
      label: t`Move or rename file path`,
      description: t`Open the Inspector file path field`,
      category: t`Asset metadata and file`,
      aliases: ['rename asset', 'move file'],
      context: t`Single Asset`,
      enabled: selectedIds().length === 1,
      disabledReason: t`Select one Asset`,
      execute: () => requestInspectorCommand('move-rename-file'),
    },
    {
      id: 'add-tag',
      label: t`Add tag`,
      description: t`Focus the Inspector tag field for the active selection`,
      category: t`Asset metadata and file`,
      aliases: ['tag assets', 'metadata'],
      context: t`Asset selection`,
      enabled: selectedIds().length > 0,
      disabledReason: t`Select Assets`,
      execute: () => requestInspectorCommand('add-tag'),
    },
    {
      id: 'save-prompt',
      label: t`Save prompt`,
      description: t`Save the current prompt from the Inspector`,
      category: t`Asset metadata and file`,
      aliases: ['edit prompt', 'prompt text'],
      context: t`Asset selection`,
      enabled: selectedIds().length > 0,
      disabledReason: t`Select Assets`,
      execute: () => requestInspectorCommand('save-prompt'),
    },
    {
      id: 'restore-from-trash',
      label: t`Restore from trash`,
      description: t`Return selected trashed assets to the repository`,
      category: t`Asset metadata and file`,
      aliases: ['restore assets'],
      context: t`Asset selection`,
      enabled: selectedImageRecords.some((image) => image.trashed),
      disabledReason: t`Select a trashed Asset`,
      execute: () =>
        Promise.all(
          selectedImageRecords
            .filter((image) => image.trashed)
            .map((image) => ImageService.RestoreImage(repo.path, image.id))
        ).then(() => reload()),
    },
    {
      id: 'compress-selection',
      label: t`Compress selected assets`,
      description: t`Open compression settings for selected Assets`,
      category: t`Asset metadata and file`,
      aliases: ['compress', 'optimize media'],
      context: t`Asset selection`,
      enabled: selectedIds().length > 0,
      disabledReason: t`Select Assets`,
      execute: () => setCompressIds(selectedIds()),
    },
    {
      id: 'compare-set',
      label: t`Compare set`,
      description: t`Open the selected set comparison`,
      category: t`Selection and sets`,
      aliases: ['compare images'],
      context: t`Set selection`,
      enabled: selection.group !== null && selectedIds().length > 1,
      disabledReason: t`Select a set with at least two assets`,
      execute: () => requestInspectorCommand('compare-set'),
    },
    {
      id: 'set-cover-image',
      label: t`Set cover image`,
      description: t`Choose a cover image in the set comparison`,
      category: t`Selection and sets`,
      aliases: ['change set thumbnail', 'cover'],
      context: t`Set selection`,
      enabled: selection.group !== null && selectedIds().length > 1,
      disabledReason: t`Select a set with at least two assets`,
      execute: () => requestInspectorCommand('compare-set'),
    },
    {
      id: 'edit-set-name',
      label: t`Edit set name`,
      description: t`Focus the selected set name field`,
      category: t`Selection and sets`,
      aliases: ['rename set'],
      context: t`Set selection`,
      enabled: selection.group !== null,
      disabledReason: t`Select a set`,
      execute: () => requestInspectorCommand('edit-set-name'),
    },
    {
      id: 'edit-set-kind',
      label: t`Edit set kind`,
      description: t`Focus the selected set kind field`,
      category: t`Selection and sets`,
      aliases: ['change set type'],
      context: t`Set selection`,
      enabled: selection.group !== null,
      disabledReason: t`Select a set`,
      execute: () => requestInspectorCommand('edit-set-kind'),
    },
    {
      id: 'expand-selected-set',
      label: t`Expand selected set`,
      description: t`Show the selected set members at their stored positions`,
      category: t`Selection and sets`,
      aliases: ['open group'],
      context: t`Set selection`,
      enabled: selection.group !== null,
      disabledReason: t`Select a set`,
      execute: () => setExpanded(selection.group),
    },
    {
      id: 'collapse-active-set',
      label: t`Collapse active set`,
      description: t`Return the expanded set to its compact thumbnail stack`,
      category: t`Selection and sets`,
      aliases: ['close group'],
      context: t`Canvas`,
      enabled: expanded !== null,
      disabledReason: t`There is no expanded set`,
      execute: () => setExpanded(null),
    },
    {
      id: 'go-to-source',
      label: t`Go to source`,
      description: t`Navigate to the source asset of the selected relationship`,
      category: t`Relationships`,
      aliases: ['source image'],
      context: t`Relationship or image`,
      enabled: canNavigateRelationship,
      disabledReason: t`Select a related image or relationship`,
      execute: () => {
        const relationship = relationshipActions[0]
        if (relationship) return go(relationship.sourceImageId)
      },
    },
    {
      id: 'go-to-derived',
      label: t`Go to derived`,
      description: t`Navigate to the derived asset of the selected relationship`,
      category: t`Relationships`,
      aliases: ['derived image'],
      context: t`Relationship or image`,
      enabled: canNavigateRelationship,
      disabledReason: t`Select a related image or relationship`,
      execute: () => {
        const relationship = relationshipActions[0]
        if (relationship) return go(relationship.derivedImageId)
      },
    },
    {
      id: 'remove-relationship',
      label: t`Remove relationship`,
      description: t`Unlink the selected relationship`,
      category: t`Relationships`,
      aliases: ['unlink'],
      context: t`One relationship`,
      enabled: canRemoveRelationship,
      disabledReason: t`Select one relationship`,
      dangerous: true,
      execute: () => {
        const relationship = relationshipActions[0]
        return relationship
          ? ImageService.UnlinkSource(repo.path, relationship.id).then(() =>
              reload()
            )
          : undefined
      },
    },
    {
      id: 'purge-selection',
      label: t`Permanently purge selected assets`,
      description: t`Permanently remove selected files and metadata`,
      category: t`Clipboard and lifecycle`,
      aliases: ['permanent delete'],
      shortcut: 'Shift+Delete',
      shortcuts: ['Shift+Delete', 'Shift+Backspace'],
      context: t`Active selection`,
      enabled: selectedIds().length > 0,
      disabledReason: t`Select assets to purge`,
      dangerous: true,
      execute: () => remove(true),
    },
    {
      id: 'copy-original',
      label: t`Copy original media`,
      description: t`Copy original files for the active selection`,
      category: t`Clipboard and lifecycle`,
      aliases: ['copy assets'],
      shortcut: 'Mod+C',
      context: t`Active selection`,
      enabled: selectedIds().length > 0,
      disabledReason: t`Select assets to copy`,
      execute: () => copyMedia(repo.path, selectedIds(), false),
    },
    {
      id: 'copy-converted',
      label: t`Copy converted media`,
      description: t`Copy converted output when a converter is available`,
      category: t`Clipboard and lifecycle`,
      aliases: ['convert and copy'],
      shortcut: 'Mod+Shift+C',
      context: t`Active selection`,
      enabled: selectedIds().length > 0,
      disabledReason: t`Select assets to copy`,
      execute: () => copyMedia(repo.path, selectedIds(), true),
    },
    {
      id: 'paste-media',
      label: t`Paste media`,
      description: t`Import copied or native clipboard media`,
      category: t`Clipboard and lifecycle`,
      aliases: ['paste files'],
      shortcut: 'Mod+V',
      context: t`Active surface`,
      enabled: true,
      execute: () => paste(),
    },
    {
      id: 'undo',
      label: t`Undo`,
      description: t`Undo the last repository operation`,
      category: t`Clipboard and lifecycle`,
      aliases: ['revert'],
      shortcut: 'Mod+Z',
      context: t`Workspace`,
      enabled: true,
      execute: undoActions.undo,
    },
    {
      id: 'redo',
      label: t`Redo`,
      description: t`Redo the last undone repository operation`,
      category: t`Clipboard and lifecycle`,
      aliases: ['reapply'],
      shortcut: 'Mod+Shift+Z',
      shortcuts: ['Mod+Shift+Z', 'Ctrl+Y'],
      context: t`Workspace`,
      enabled: true,
      execute: undoActions.redo,
    },
  ]
  const actionById = new Map(actionCatalog.map((action) => [action.id, action]))
  const actionRef = useRef(actionCatalog)
  actionRef.current = actionCatalog
  function executeAction(action: CanvasAction) {
    if (!action.enabled) return Promise.resolve()
    return Promise.resolve(action.execute()).catch(report)
  }
  function executeActionById(id: string) {
    const action = actionById.get(id)
    if (action) void executeAction(action)
  }
  function runPaletteAction(action: CanvasAction) {
    changePaletteOpen(false)
    requestAnimationFrame(() => {
      void executeAction(action).then(() =>
        setRecentActionIds((ids) =>
          [action.id, ...ids.filter((id) => id !== action.id)].slice(0, 6)
        )
      )
    })
  }
  function choosePaletteAsset(asset: PaletteAsset) {
    changePaletteOpen(false)
    requestAnimationFrame(() => void go(asset.id).catch(report))
  }
  useEffect(() => {
    if (!paletteOpen) return
    let cancelled = false
    void LibraryService.ListImages(repo.path, {
      search: '',
      placement: '',
      status: 'all',
      tagId: 0,
    })
      .then((rows) => {
        if (!cancelled)
          setPaletteAssets(
            (rows ?? [])
              .filter((row) => !row.trashed)
              .map((row) => ({
                id: row.id,
                fileName: row.fileName,
                filePath: row.filePath,
                tags: row.tags ?? [],
              }))
          )
      })
      .catch(callbacks.current.report)
    return () => {
      cancelled = true
    }
  }, [paletteOpen, repo.path])
  const keyboardState = useRef({
    assetsOpen,
    assetsPinned,
    closeAssets,
    closeInspector,
    compressIds,
    executeAction,
    expanded,
    inspectorOpen,
    inspectorPinned,
    isMac,
    menu,
    openPalette,
    paletteOpen,
    previewImageId,
    purgeIds,
    repoMenuOpen,
    selection,
  })
  keyboardState.current = {
    assetsOpen,
    assetsPinned,
    closeAssets,
    closeInspector,
    compressIds,
    executeAction,
    expanded,
    inspectorOpen,
    inspectorPinned,
    isMac,
    menu,
    openPalette,
    paletteOpen,
    previewImageId,
    purgeIds,
    repoMenuOpen,
    selection,
  }
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const state = keyboardState.current
      const target = event.target
      const inEditable =
        target instanceof HTMLElement &&
        !!target.closest(
          'input,textarea,select,[contenteditable=true],[role=dialog]'
        )
      if (event.code === 'Space' && !inEditable && !state.paletteOpen) {
        event.preventDefault()
        setSpace(true)
        return
      }
      if (
        state.paletteOpen ||
        state.purgeIds ||
        state.compressIds ||
        state.previewImageId !== null
      )
        return
      if (event.key === 'Escape') {
        if (state.menu) {
          setMenu(null)
          event.preventDefault()
          return
        }
        if (state.repoMenuOpen) {
          setRepoMenuOpen(false)
          event.preventDefault()
          return
        }
        if (document.querySelector('[role="dialog"]')) return
        if (document.querySelector('[role="menu"]')) return
        if (state.inspectorOpen && !state.inspectorPinned)
          state.closeInspector()
        else if (state.assetsOpen && !state.assetsPinned) state.closeAssets()
        else if (inEditable) return
        else if (
          state.selection.ids.length ||
          state.selection.edges.length ||
          state.selection.group
        )
          setSelection(emptySelection)
        else if (state.expanded !== null) setExpanded(null)
        else return
        event.preventDefault()
        return
      }
      if (inEditable || state.menu) return
      const action = actionRef.current.find(
        (candidate) =>
          candidate.enabled &&
          (
            candidate.shortcuts ??
            (candidate.shortcut ? [candidate.shortcut] : [])
          ).some(
            (shortcut) =>
              (shortcut !== 'Ctrl+Y' || !state.isMac) &&
              shortcutMatches(event, shortcut)
          )
      )
      if (!action) return
      event.preventDefault()
      if (action.id === 'show-commands') state.openPalette(false)
      else if (action.id === 'show-shortcuts') state.openPalette(true)
      else void state.executeAction(action)
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpace(false)
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
  }, [])
  function menuAction(
    id: string,
    key = id,
    label?: string,
    separatorBefore = false
  ): MenuAction {
    const action = actionById.get(id)
    return {
      key,
      label: label ?? action?.label ?? id,
      disabled: !action?.enabled,
      danger: action?.dangerous,
      separatorBefore,
      onSelect: () => {
        if (action) void executeAction(action)
      },
    }
  }
  const menuItems: MenuAction[] = (() => {
    if (!menu) return []
    const showCommands = menuAction('show-commands')
    if (menu.kind === 'pane')
      return [
        menuAction('select-all-canvas'),
        menuAction('auto-arrange-canvas', 'auto-arrange'),
        showCommands,
      ]
    if (menu.kind === 'selection')
      return [
        menuAction('create-set'),
        menuAction('auto-arrange-selection'),
        menuAction(
          'unplace-selection',
          'remove-from-canvas',
          t`Remove from canvas`,
          true
        ),
        menuAction('trash-canvas-selection', 'trash', t`Trash selection`),
        showCommands,
      ]
    const nodeId = menu.nodeId
    if (!nodeId) return [showCommands]
    if (nodeId.startsWith('set-'))
      return [menuAction('dissolve-set'), showCommands]
    const image = (data.images ?? []).find(
      (candidate) => candidate.id === Number(nodeId)
    )
    if (!image) return [showCommands]
    return [
      menuAction('find-in-assets', 'find-assets', t`Find in Assets`),
      menuAction('unplace-selection', 'remove', t`Remove from canvas`, true),
      image.archived
        ? menuAction('unarchive-selection', 'archive')
        : menuAction('archive-selection', 'archive'),
      menuAction('trash-canvas-selection', 'trash', t`Trash`),
      showCommands,
    ]
  })()
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
      <div className="absolute inset-0">
        <ShelfPanel
          title={t`Assets`}
          side="left"
          open={assetsOpen}
          onOpenChange={(open) =>
            executeActionById(open ? 'open-assets' : 'close-assets')
          }
          pinned={assetsPinned}
          onPinnedChange={(pinned) =>
            executeActionById(pinned ? 'pin-assets' : 'unpin-assets')
          }
          focusHidden={focusCanvas}
          shortcutHint={displayShortcut(
            actionById.get('toggle-assets')?.shortcut ?? '',
            isMac
          )}
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
            compress={(ids) => {
              selectAssets(ids)
              requestAnimationFrame(() =>
                executeActionById('compress-selection')
              )
            }}
            searchFocusRequest={searchFocusRequest}
            navigatorModeRequest={navigatorModeRequest}
            onShowCommands={() => executeActionById('show-commands')}
          />
        </ShelfPanel>
        <main
          ref={host}
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
                  if (!assetsPinned) {
                    closeAssets(false)
                    requestAnimationFrame(() => host.current?.focus())
                  }
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
          {!focusCanvas && (
            <SelectionHud
              selectedNodes={displayNodes.filter((n) => n.selected)}
              hostRef={host}
              canCreateSet={canCreateSet}
              onCreateSet={() => executeActionById('create-set')}
              onAlignHorizontal={() => executeActionById('align-horizontal')}
              onAlignVertical={() => executeActionById('align-vertical')}
              onArrangeSubgraph={() =>
                executeActionById('auto-arrange-selection')
              }
              onUnplace={() => executeActionById('unplace-selection')}
              onPreview={() => executeActionById('preview-selection')}
              onLocate={() => executeActionById('locate-selection')}
              onMore={handleMore}
            />
          )}
          {!focusCanvas && (
            <CanvasDock
              canFitAll={displayNodes.length > 0}
              canFitSelection={displayNodes.some((n) => n.selected)}
              canAutoArrange={displayNodes.length >= 2}
              shortcuts={{
                fitAll: actionById.get('fit-all')?.shortcut ?? '',
                fitSelection: actionById.get('fit-selection')?.shortcut ?? '',
                resetZoom: actionById.get('reset-zoom')?.shortcut ?? '',
                autoArrange:
                  actionById.get('auto-arrange-active')?.shortcut ?? '',
              }}
              onFitAll={() => executeActionById('fit-all')}
              onFitSelection={() => executeActionById('fit-selection')}
              onResetZoom={() => executeActionById('reset-zoom')}
              onAutoArrange={() => executeActionById('auto-arrange-active')}
            />
          )}
        </main>
        <ShelfPanel
          title={t`Inspector`}
          deferOpeningFocus={inspectorCommandRequest?.pending ?? false}
          side="right"
          open={inspectorOpen}
          onOpenChange={(open) =>
            executeActionById(open ? 'open-inspector' : 'close-inspector')
          }
          pinned={inspectorPinned}
          onPinnedChange={(pinned) =>
            executeActionById(pinned ? 'pin-inspector' : 'unpin-inspector')
          }
          focusHidden={focusCanvas}
          shortcutHint={displayShortcut(
            actionById.get('toggle-inspector')?.shortcut ?? '',
            isMac
          )}
        >
          <DetailPanel
            path={repo.path}
            data={data}
            selection={selection}
            change={reload}
            go={(id, folder) => void go(id, folder).catch(report)}
            onError={report}
            commandRequest={inspectorCommandRequest}
            onCommandRequestHandled={handleInspectorCommandRequest}
            onAction={executeActionById}
            onSubmitField={submitInspectorField}
            restoreEnabled={
              actionById.get('restore-from-trash')?.enabled ?? false
            }
          />
        </ShelfPanel>
      </div>
      <div
        role="toolbar"
        aria-label={t`Canvas workspace controls`}
        data-testid="canvas-workspace-controls"
        aria-hidden={focusCanvas}
        inert={focusCanvas}
        className={cn(
          'absolute left-1/2 top-3 z-40 flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card/95 p-1.5 shadow-xl backdrop-blur-xl transition-opacity motion-reduce:transition-none',
          focusCanvas && 'pointer-events-none opacity-0'
        )}
      >
        <h1 className="sr-only">
          <Trans>Canvas</Trans>
        </h1>
        <RepoSelect repo={repo} openRequest={repoOpenRequest} />
        <button
          type="button"
          aria-label={t`Show commands`}
          title={t`Show commands (${displayShortcut(actionById.get('show-commands')?.shortcut ?? '', isMac)})`}
          data-testid="open-command-palette"
          onClick={() => openPalette(false)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink/75 transition-colors hover:bg-black/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <Command className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={t`Assets`}
          aria-expanded={assetsOpen}
          title={t`Toggle Assets shelf (${displayShortcut(actionById.get('toggle-assets')?.shortcut ?? '', isMac)})`}
          data-testid="toggle-assets-shelf"
          onClick={() => executeActionById('toggle-assets')}
          className={cn(
            'inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-primary/40',
            assetsOpen
              ? 'bg-primary-soft text-ink'
              : 'text-ink/75 hover:bg-black/[0.06] hover:text-ink'
          )}
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={t`Inspector`}
          aria-expanded={inspectorOpen}
          title={t`Toggle Inspector shelf (${displayShortcut(actionById.get('toggle-inspector')?.shortcut ?? '', isMac)})`}
          data-testid="toggle-inspector-shelf"
          onClick={() => executeActionById('toggle-inspector')}
          className={cn(
            'inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-primary/40',
            inspectorOpen
              ? 'bg-primary-soft text-ink'
              : 'text-ink/75 hover:bg-black/[0.06] hover:text-ink'
          )}
        >
          <PanelRight className="h-4 w-4" />
        </button>
        <div className="relative">
          <button
            type="button"
            aria-label={t`Repository actions`}
            aria-haspopup="menu"
            aria-expanded={repoMenuOpen}
            data-testid="repository-actions"
            onClick={() => setRepoMenuOpen((open) => !open)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink/75 transition-colors hover:bg-black/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {repoMenuOpen && (
            <div
              role="menu"
              aria-label={t`Repository actions`}
              className="absolute right-0 top-11 z-50 grid min-w-44 gap-1 rounded-lg border border-border bg-card p-1.5 shadow-xl"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setRepoMenuOpen(false)
                  executeActionById('rescan-repository')
                }}
                className="rounded px-3 py-2 text-left text-xs hover:bg-black/[0.05] focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <Trans>Rescan repository</Trans>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setRepoMenuOpen(false)
                  importInput.current?.click()
                }}
                className="rounded px-3 py-2 text-left text-xs hover:bg-black/[0.05] focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <Trans>Import media</Trans>
              </button>
            </div>
          )}
        </div>
        <input
          ref={importInput}
          type="file"
          multiple
          accept="image/*,video/*"
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            void filesToMedia(files)
              .then((media) => paste(media, 'assets'))
              .catch(report)
            event.target.value = ''
          }}
        />
      </div>
      {focusCanvas && (
        <button
          type="button"
          aria-label={t`Exit Focus Canvas mode`}
          title={t`Exit Focus Canvas (${displayShortcut(actionById.get('toggle-focus-canvas')?.shortcut ?? '', isMac)})`}
          onClick={toggleFocusMode}
          className="group absolute left-0 top-1/2 z-40 flex h-12 w-2 -translate-y-1/2 items-center gap-2 overflow-hidden rounded-r-full border border-border bg-card/70 px-1 text-xs font-medium text-ink opacity-55 shadow-lg backdrop-blur transition-[width,opacity] hover:w-48 hover:bg-card/90 hover:opacity-100 focus-visible:w-48 focus-visible:bg-card/90 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
        >
          <PanelLeft className="h-4 w-4 rotate-180" />
          <span className="whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">
            <Trans>Exit Focus Canvas</Trans>
          </span>
        </button>
      )}
      <CommandPalette
        open={paletteOpen}
        shortcutsOnly={shortcutsOnly}
        initialQuery={paletteInitialQuery}
        actions={actionCatalog}
        recentActionIds={recentActionIds}
        assets={paletteAssets}
        onOpenChange={changePaletteOpen}
        onRunAction={runPaletteAction}
        onChooseAsset={choosePaletteAsset}
      />
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
              <Plural
                value={purgeIds?.length ?? 0}
                one="Permanently delete # asset?"
                other="Permanently delete # assets?"
              />
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-xs leading-relaxed text-ink-muted">
              <Trans>
                This removes the files and Loom metadata immediately. Trash
                retention does not apply, and this action cannot be undone.
              </Trans>
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
