import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  type Edge,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
} from '@xyflow/react'
import { useEffect, useRef, useState } from 'react'
import '@xyflow/react/dist/style.css'
import {
  type CanvasData,
  GroupService,
  ImageService,
  type RepoInfo,
} from '../../bindings/loom/internal/service'
import { DetailPanel } from '../components/canvas/detail-panel'
import { FloatingPanel } from '../components/canvas/floating-panel'
import { GroupNode } from '../components/canvas/group-node'
import { ImageNode } from '../components/canvas/image-node'
import { LibraryPanel } from '../components/canvas/library-panel'
import { RepoSelect } from '../components/canvas/repo-select'
import { CompressionDialog } from '../components/compression-dialog'
import { Button } from '../components/ui/button'
import { copyMedia, filesToMedia, readMedia } from '../lib/clipboard'
import { computeSubgraphLayout } from '../lib/layout'
import { emptySelection, type Selection } from '../lib/selection'
import { useGroupShortcut, useUndoShortcuts } from '../lib/use-undo'

const nodeTypes = { image: ImageNode, group: GroupNode }
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
  const [reveal, setReveal] = useState<{
    id: number
    folder: string | null
  } | null>(null)
  const visible = useRef<number[]>([]),
    relation = useRef<{ source: number; x: number; y: number } | null>(null)
  const [target, setTarget] = useState<{ id: string; valid: boolean } | null>(
    null
  )
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
        if (!v) setTimeout(() => void flow.fitView({ padding: 0.2 }), 100)
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
  const displayNodes = nodes.map((n) => ({
    ...n,
    selected:
      selection.surface === 'canvas' &&
      (n.type === 'group'
        ? selection.group === Number(n.id.slice(4))
        : selection.ids.includes(Number(n.id))),
    className:
      target?.id === n.id
        ? target.valid
          ? 'ring-4 ring-green-500'
          : 'ring-4 ring-red-500'
        : '',
  }))
  const displayEdges = edges.map((e) => ({
    ...e,
    selected:
      selection.surface === 'canvas' && selection.edges.includes(Number(e.id)),
  }))
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
      if (
        !ids.length ||
        !window.confirm(
          `Permanently purge ${ids.length} assets? This cannot be undone.`
        )
      )
        return
      await ImageService.PurgeImages(repo.path, ids)
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
  const latest = useRef({ selection, selectedIds, remove, paste })
  latest.current = { selection, selectedIds, remove, paste }
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
      if (!(e.ctrlKey || e.metaKey)) return
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
  async function arrange() {
    const placed = (data.images ?? []).filter((i) => i.placed)
    const positions = computeSubgraphLayout(
      placed.map((i) => String(i.id)),
      (data.relationships ?? []).map((r) => ({
        source: String(r.sourceImageId),
        target: String(r.derivedImageId),
      }))
    )
    await ImageService.SetPositions(
      repo.path,
      [...positions].map(([id, p]) => ({ imageId: Number(id), ...p }))
    )
    await reload()
  }
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
        <RepoSelect repo={repo} />
        <h1 className="text-xs font-semibold">Canvas</h1>
        {toolbar('Rescan', reload)}
        <label className="inline-flex h-8 cursor-pointer items-center justify-center rounded-sm border border-black/16 px-3 text-xs font-semibold text-ink transition-colors hover:bg-black/[0.03] focus-within:ring-2 focus-within:ring-primary/40">
          Import
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
      </header>
      {error && (
        <div role="alert" className="bg-red-100 p-2 text-sm">
          {error}
          <button type="button" onClick={() => setError('')}>
            Dismiss
          </button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        <FloatingPanel title="Assets" side="left">
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
            compress={setCompressIds}
          />
        </FloatingPanel>
        <main
          ref={host}
          aria-label="Canvas"
          className="relative min-w-0 flex-1"
          onPointerDownCapture={(e) => {
            const id = targetAt(e.clientX, e.clientY)
            if ((e.ctrlKey || e.metaKey) && id && !id.startsWith('set-')) {
              relation.current = {
                source: Number(id),
                x: e.clientX,
                y: e.clientY,
              }
              e.currentTarget.setPointerCapture(e.pointerId)
              e.stopPropagation()
              e.preventDefault()
            }
          }}
          onPointerCancel={() => {
            relation.current = null
            setTarget(null)
          }}
          onPointerMove={(e) => {
            if (!relation.current) return
            const id = targetAt(e.clientX, e.clientY)
            setTarget(
              id
                ? { id, valid: validTarget(relation.current.source, id) }
                : null
            )
          }}
          onPointerUp={(e) => {
            const drag = relation.current
            if (!drag) return
            relation.current = null
            setTarget(null)
            const id = targetAt(e.clientX, e.clientY)
            if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) {
              setSelection((s) => ({
                surface: 'canvas',
                ids: s.ids.includes(drag.source)
                  ? s.ids.filter((i) => i !== drag.source)
                  : [...(s.surface === 'canvas' ? s.ids : []), drag.source],
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
            multiSelectionKeyCode={['Shift', 'Control', 'Meta']}
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
            onNodeClick={(_, node) => {
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
            onNodeDragStop={(_, node, moved) => {
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
          >
            <Background />
          </ReactFlow>
          <div className="absolute bottom-3 left-3 right-3 flex flex-wrap gap-1 text-xs">
            {toolbar(
              'Fit all',
              async () => {
                await flow.fitView({ padding: 0.2 })
                await ImageService.SetViewport(repo.path, flow.getViewport())
              },
              displayNodes.length === 0
            )}
            {toolbar(
              'Fit selection',
              async () => {
                await flow.fitView({
                  nodes: displayNodes.filter((n) => n.selected),
                  padding: 0.2,
                })
                await ImageService.SetViewport(repo.path, flow.getViewport())
              },
              !displayNodes.some((n) => n.selected)
            )}
            {toolbar('Reset 100%', async () => {
              const p = center()
              await flow.setCenter(p.x, p.y, { zoom: 1 })
              await ImageService.SetViewport(repo.path, flow.getViewport())
            })}
            {toolbar('Auto-arrange', arrange, displayNodes.length < 2)}
            {toolbar('Create set', createSet, !canCreateSet)}
          </div>
        </main>
        <FloatingPanel title="Inspector" side="right">
          <DetailPanel
            path={repo.path}
            data={data}
            selection={selection}
            change={reload}
            go={(id, folder) => void go(id, folder).catch(report)}
            onError={report}
          />
        </FloatingPanel>
      </div>
      {compressIds && (
        <CompressionDialog
          path={repo.path}
          assetIds={compressIds}
          onClose={() => setCompressIds(null)}
          onChange={reload}
        />
      )}
    </div>
  )
}
