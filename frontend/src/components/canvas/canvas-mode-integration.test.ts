import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { Edge, Node, Viewport } from '@xyflow/react'
import { useRef, useState, useSyncExternalStore } from 'react'
import {
  type CanvasData,
  type GeometryUpdate,
  ImageService,
} from '../../../bindings/loom/internal/service'
import { emptySelection } from '../../lib/selection'
import { useCanvasBoardOwner } from './canvas-board-owner'
import { data, empty, images, relationships } from './canvas-mode-test-fixtures'
import { useCanvasBoardModel } from './use-canvas-board-model'

const ignoreSelection = () => {}
let viewport: Viewport = { x: 0, y: 0, zoom: 1 }
afterEach(() => {
  cleanup()
  mock.restore()
})

it('arranges the displayed Edit graph as one guarded batch, not stored coordinates', async () => {
  spyOn(ImageService, 'LoadCanvas').mockResolvedValue(data as never)
  let links = relationships
  let geometry: GeometryUpdate[] = images.map((image) => ({
    imageId: image.id,
    x: image.canvasX,
    y: image.canvasY,
    w: 150,
    h: 110,
  }))
  let releaseWrite = () => {}
  let writeStarted = () => {}
  const started = new Promise<void>((resolve) => {
    writeStarted = resolve
  })
  const gate = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  spyOn(ImageService, 'GetLayoutSnapshot').mockImplementation(
    () =>
      Promise.resolve({
        revision: '1',
        relationships: links,
        images: images.map((image) => ({
          id: image.id,
          width: image.width,
          height: image.height,
          geometry: geometry.find((row) => row.imageId === image.id),
        })),
      }) as never
  )
  const write = spyOn(
    ImageService,
    'SetGeometryFromDisplayAtRevision'
  ).mockImplementation(async (_path, _revision, _expected, _before, after) => {
    writeStarted()
    await gate
    geometry = after
    return undefined as never
  })
  const { result } = renderHook(() => {
    const owner = useCanvasBoardOwner('/mode-layout-batch')
    const board = useSyncExternalStore(owner.subscribe, owner.getSnapshot)
    const [nodes, setNodes] = useState<Node[]>([])
    const [edges, setEdges] = useState<Edge[]>([])
    const model = useCanvasBoardModel({
      data: board?.data ?? empty,
      owner,
      renditionGeneration: 0,
      callbacks: useRef({ report: mock() }),
      selection: emptySelection,
      setSelection: ignoreSelection,
      nodes,
      setNodes,
      edges,
      setEdges,
      target: null,
      host: useRef(null),
    })
    return { owner, nodes, setNodes, model }
  })
  await act(async () => {
    await result.current.owner.refresh()
  })
  await act(async () => {
    await result.current.model.transitionMode('edit')
  })
  act(() =>
    result.current.setNodes((nodes) =>
      nodes.map((node) =>
        node.id === '1'
          ? {
              ...node,
              position: { x: 900, y: 800 },
              width: 250,
              height: 180,
              measured: { width: 250, height: 180 },
            }
          : node
      )
    )
  )
  links = [{ ...relationships[0], sourceImageId: 2, derivedImageId: 1 }]
  await act(async () => {
    await result.current.owner.refresh()
  })
  const before = result.current.nodes.map((node) => {
    const stored = geometry.find((item) => item.imageId === Number(node.id))
    if (!stored) throw new Error(`missing geometry for ${node.id}`)
    return {
      imageId: Number(node.id),
      ...node.position,
      w: stored.w,
      h: stored.h,
    }
  })
  let arranging: Promise<void> = Promise.resolve()
  await act(async () => {
    arranging = result.current.owner.execute(() =>
      result.current.model.arrangeEdit()
    )
    await started
    await result.current.owner.refresh()
  })
  await act(async () => {
    releaseWrite()
    await arranging
  })
  expect(write).toHaveBeenCalledTimes(1)
  expect(write.mock.calls[0][2][0]).toEqual({
    imageId: 1,
    x: 10,
    y: 20,
    w: 150,
    h: 110,
  })
  expect(write.mock.calls[0][3]).toEqual(before)
  expect(write.mock.calls[0][4]).toHaveLength(3)
  expect(result.current.nodes[0].position).not.toEqual({ x: 900, y: 800 })
  const arranged = result.current.nodes.map((node) => node.position)
  expect(arranged).toEqual(geometry.map(({ x, y }) => ({ x, y })))
  expect(arranged[1].x).toBeLessThan(arranged[0].x)
  await act(async () => {
    await result.current.owner.execute(() => result.current.model.arrangeEdit())
  })
  expect(write).toHaveBeenCalledTimes(1)
  expect(result.current.nodes.map((node) => node.position)).toEqual(arranged)
  const after = write.mock.calls[0][4]
  geometry = before
  await act(async () => {
    await result.current.owner.applyHistory({
      applied: true,
      kind: 'geometry',
      geometry,
    } as never)
  })
  expect(result.current.nodes.map((node) => node.position)).toEqual(
    before.map(({ x, y }) => ({ x, y }))
  )
  geometry = after
  await act(async () => {
    await result.current.owner.applyHistory({
      applied: true,
      kind: 'geometry',
      geometry,
    } as never)
  })
  expect(result.current.nodes.map((node) => node.position)).toEqual(arranged)
  act(() =>
    result.current.setNodes((nodes) =>
      nodes.map((node) =>
        node.id === '1' ? { ...node, position: { x: 1234, y: 5678 } } : node
      )
    )
  )
  write.mockRejectedValueOnce(new Error('stale revision'))
  await act(async () => {
    await expect(
      result.current.owner.execute(() => result.current.model.arrangeEdit())
    ).rejects.toThrow('stale revision')
  })
  expect(result.current.nodes[0].position).toEqual({ x: 1234, y: 5678 })
  await expect(
    result.current.owner.execute(() => result.current.model.arrangeEdit())
  ).rejects.toThrow('Canvas write outcome is unknown')
  expect(write).toHaveBeenCalledTimes(2)
})

it('uses accepted snapshots for internal View and Edit while preserving Edit geometry on refresh', async () => {
  spyOn(ImageService, 'LoadCanvas').mockResolvedValue(data as never)
  const writeGeometry = spyOn(
    ImageService,
    'SetGeometryFromDisplayAtRevision'
  ).mockResolvedValue(undefined as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
    revision: '1',
    relationships,
    images: images.map((image) => ({
      id: image.id,
      width: image.width,
      height: image.height,
      geometry: {
        imageId: image.id,
        x: image.canvasX,
        y: image.canvasY,
        w: 150,
        h: 110,
      },
    })),
  } as never)
  viewport = { x: 0, y: 0, zoom: 1 }
  const flow = {
    getViewport: () => viewport,
    setViewport: async (next: Viewport) => {
      viewport = next
      return true
    },
  }
  const { result } = renderHook(() => {
    const owner = useCanvasBoardOwner('/mode-snapshot-replay')
    const board = useSyncExternalStore(owner.subscribe, owner.getSnapshot)
    const [nodes, setNodes] = useState<Node[]>([])
    const [edges, setEdges] = useState<Edge[]>([])
    const callbacks = useRef({ report: mock() })
    const host = useRef<HTMLDivElement | null>(null)
    const model = useCanvasBoardModel({
      data: board?.data ?? empty,
      owner,
      renditionGeneration: 0,
      callbacks,
      selection: emptySelection,
      setSelection: ignoreSelection,
      nodes,
      setNodes,
      edges,
      setEdges,
      target: null,
      host,
      flow,
    })
    return { owner, nodes, setNodes, model }
  })
  await act(async () => {
    await result.current.owner.refresh()
  })
  await act(async () => {
    await result.current.model.transitionMode('view')
  })
  await waitFor(() =>
    expect(result.current.nodes.map((node) => node.id)).toEqual(['1', '2'])
  )
  expect(
    result.current.owner.beginDrag(result.current.owner.getSnapshot(), [
      { imageId: 1, x: 0, y: 0, w: 150, h: 110 },
    ])
  ).toBeNull()
  expect(
    result.current.owner.beginResize(result.current.owner.getSnapshot(), {
      imageId: 1,
      x: 0,
      y: 0,
      w: 150,
      h: 110,
    })
  ).toBeNull()
  const view = result.current.nodes.map((node) => node.position)
  await act(async () => {
    await result.current.model.transitionMode('edit')
  })
  expect(result.current.nodes.map((node) => node.id)).toEqual(['1', '2', '3'])
  expect(result.current.nodes.slice(0, 2).map((node) => node.position)).toEqual(
    view
  )
  expect(writeGeometry).not.toHaveBeenCalled()
  const pending = result.current.owner.beginDrag(
    result.current.owner.getSnapshot(),
    [{ imageId: 1, x: view[0].x, y: view[0].y, w: 150, h: 110 }]
  )
  if (!pending) throw new Error('expected Edit drag')
  await act(async () => {
    await result.current.model.transitionMode('view')
    await result.current.owner.endDrag(pending, [
      { imageId: 1, x: 900, y: 800, w: 150, h: 110 },
    ])
  })
  expect(writeGeometry).not.toHaveBeenCalled()
  await act(async () => {
    await result.current.model.transitionMode('edit')
  })
  const boxes = result.current.nodes.map((node) => ({
    ...node.position,
    w: node.width ?? 150,
    h: node.height ?? 110,
  }))
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i],
        b = boxes[j]
      expect(
        a.x + a.w <= b.x ||
          b.x + b.w <= a.x ||
          a.y + a.h <= b.y ||
          b.y + b.h <= a.y
      ).toBe(true)
    }
  const before = {
    imageId: 1,
    ...result.current.nodes[0].position,
    w: 150,
    h: 110,
  }
  const gesture = result.current.owner.beginDrag(
    result.current.owner.getSnapshot(),
    [before]
  )
  if (!gesture) throw new Error('expected guarded drag')
  act(() =>
    result.current.setNodes((nodes) =>
      nodes.map((node) =>
        node.id === '1' ? { ...node, position: { x: 900, y: 800 } } : node
      )
    )
  )
  await act(async () => {
    await result.current.owner.endDrag(gesture, [{ ...before, x: 900, y: 800 }])
  })
  expect(writeGeometry).toHaveBeenCalledWith(
    '/mode-snapshot-replay',
    '1',
    [{ imageId: 1, x: 10, y: 20, w: 150, h: 110 }],
    [before],
    [{ ...before, x: 900, y: 800 }]
  )
  expect(result.current.nodes[0].position).toEqual({ x: 900, y: 800 })
})

it('replays snapshot geometry in Edit and compensates the View anchor while keeping mode viewports independent', async () => {
  const extra = { ...images[2], id: 4, fileName: '4.png' }
  const all = [...images, extra]
  const metadata: CanvasData = { ...data, images: all }
  let links = [
    {
      id: 8,
      sourceImageId: 3,
      derivedImageId: 4,
      pairingOrder: 1,
      createdAt: null,
    },
    {
      id: 7,
      sourceImageId: 1,
      derivedImageId: 2,
      pairingOrder: 2,
      createdAt: null,
    },
  ]
  let geometry = all.map((image) => ({
    imageId: image.id,
    x: image.canvasX as number | null,
    y: image.canvasY as number | null,
    w: 150 as number | null,
    h: 110 as number | null,
  }))
  spyOn(ImageService, 'LoadCanvas').mockResolvedValue(metadata as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockImplementation(
    () =>
      Promise.resolve({
        revision: '1',
        relationships: links,
        images: all.map((image) => ({
          id: image.id,
          width: image.width,
          height: image.height,
          geometry: geometry.find((row) => row.imageId === image.id),
        })),
      }) as never
  )
  viewport = { x: 40, y: 80, zoom: 2 }
  const flow = {
    getViewport: () => viewport,
    setViewport: async (next: Viewport) => {
      viewport = next
      return true
    },
  }
  const { result } = renderHook(() => {
    const owner = useCanvasBoardOwner('/mode-anchor-viewports')
    const board = useSyncExternalStore(owner.subscribe, owner.getSnapshot)
    const [nodes, setNodes] = useState<Node[]>([])
    const [edges, setEdges] = useState<Edge[]>([])
    const callbacks = useRef({ report: mock() })
    const host = useRef<HTMLDivElement | null>(null)
    const model = useCanvasBoardModel({
      data: board?.data ?? empty,
      owner,
      renditionGeneration: 0,
      callbacks,
      selection: emptySelection,
      setSelection: ignoreSelection,
      nodes,
      setNodes,
      edges,
      setEdges,
      target: null,
      host,
      flow,
    })
    return { owner, nodes, setNodes, model }
  })
  await act(async () => {
    await result.current.owner.refresh()
  })
  await act(async () => {
    await result.current.model.transitionMode('view')
  })
  const find = (id: string) => {
    const node = result.current.nodes.find((item) => item.id === id)
    if (!node) throw new Error(`missing node ${id}`)
    return node
  }
  const old = find('1').position
  act(() => result.current.model.setViewAnchor(old))
  const beforeScreen = {
    x: old.x * viewport.zoom + viewport.x,
    y: old.y * viewport.zoom + viewport.y,
  }
  links = links.filter((link) => link.id === 7)
  await act(async () => {
    await result.current.owner.applyHistory({
      applied: true,
      kind: 'unlink',
      geometry: null,
    } as never)
  })
  const moved = find('1').position
  expect({
    x: moved.x * viewport.zoom + viewport.x,
    y: moved.y * viewport.zoom + viewport.y,
  }).toEqual(beforeScreen)
  const viewViewport = viewport
  await act(async () => {
    await result.current.model.transitionMode('edit')
  })
  viewport = { x: -200, y: 100, zoom: 0.5 }
  act(() => result.current.model.updateProjectionViewport(viewport))
  act(() =>
    result.current.setNodes((nodes) =>
      nodes.map((node) =>
        node.id === '1' ? { ...node, position: { x: 500, y: 600 } } : node
      )
    )
  )
  links = []
  await act(async () => {
    await result.current.owner.applyHistory({
      applied: true,
      kind: 'unlink',
      geometry: null,
    } as never)
  })
  expect(find('1').position).toEqual({ x: 500, y: 600 })
  geometry = geometry.map((row) =>
    row.imageId === 1 ? { ...row, x: 25, y: 35, w: null, h: null } : row
  )
  await act(async () => {
    await result.current.owner.applyHistory({
      applied: true,
      kind: 'geometry',
      geometry: [geometry[0]],
    } as never)
  })
  expect(find('1').position).toEqual({ x: 25, y: 35 })
  geometry = geometry.map((row) =>
    row.imageId === 1 ? { ...row, x: null, y: null } : row
  )
  await act(async () => {
    await result.current.owner.applyHistory({
      applied: true,
      kind: 'geometry',
      geometry: [geometry[0]],
    } as never)
  })
  expect(find('1').position).toEqual({ x: 25, y: 35 })
  await act(async () => {
    await result.current.model.transitionMode('view')
  })
  expect(viewport).toEqual(viewViewport)
  expect(result.current.nodes).toEqual([])
  await act(async () => {
    await result.current.model.transitionMode('edit')
  })
  expect(viewport).toEqual({ x: -200, y: 100, zoom: 0.5 })
})
