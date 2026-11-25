import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { Edge, Node, Viewport } from '@xyflow/react'
import { useRef, useState, useSyncExternalStore } from 'react'
import {
  type CanvasData,
  ImageService,
} from '../../../bindings/loom/internal/service'
import { emptySelection } from '../../lib/selection'
import { useCanvasBoardOwner } from './canvas-board-owner'
import { useCanvasBoardModel } from './use-canvas-board-model'

const images = [1, 2, 3].map((id) => ({
  id,
  fileName: `${id}.png`,
  filePath: '',
  thumbUrl: '',
  previewUrl: '',
  fullUrl: '',
  width: 640,
  height: 480,
  archived: false,
  trashed: false,
  missing: false,
  placed: true,
  canvasX: id * 10,
  canvasY: 20,
  canvasW: 150,
  canvasH: 110,
  promptText: '',
  groupId: 0,
  createdAt: '',
}))
const data: CanvasData = { images, relationships: [], groups: [] }
const empty: CanvasData = { images: [], relationships: [], groups: [] }
const relationships = [
  {
    id: 7,
    sourceImageId: 1,
    derivedImageId: 2,
    pairingOrder: 1,
    createdAt: null,
  },
]
let viewport: Viewport = { x: 0, y: 0, zoom: 1 }

afterEach(() => {
  cleanup()
  mock.restore()
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
    const owner = useCanvasBoardOwner('/repo')
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
  const view = result.current.nodes.map((node) => node.position)
  await act(async () => {
    await result.current.model.transitionMode('edit')
  })
  expect(result.current.nodes.map((node) => node.id)).toEqual(['1', '2', '3'])
  expect(result.current.nodes.slice(0, 2).map((node) => node.position)).toEqual(
    view
  )
  expect(writeGeometry).not.toHaveBeenCalled()
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
    '/repo',
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
    const owner = useCanvasBoardOwner('/repo')
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
