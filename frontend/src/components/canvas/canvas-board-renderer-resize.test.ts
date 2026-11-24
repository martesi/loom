import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { Edge, Node } from '@xyflow/react'
import { useRef, useState, useSyncExternalStore } from 'react'
import {
  type CanvasData,
  ImageService,
} from '../../../bindings/loom/internal/service'
import { emptySelection } from '../../lib/selection'
import { useCanvasBoardOwner } from './canvas-board-owner'
import { useCanvasBoardModel } from './use-canvas-board-model'

const rectangle = { imageId: 1, x: 10, y: 20, w: 150, h: 110 }
const resized = { imageId: 1, x: 1, y: 2, w: 300, h: 200 }
const data: CanvasData = {
  images: [
    {
      id: 1,
      fileName: 'image.png',
      filePath: 'image.png',
      thumbUrl: '',
      previewUrl: '',
      fullUrl: '',
      width: 640,
      height: 480,
      archived: false,
      trashed: false,
      missing: false,
      placed: true,
      canvasX: 10,
      canvasY: 20,
      canvasW: 150,
      canvasH: 110,
      promptText: '',
      groupId: 0,
      createdAt: '',
    },
  ],
  relationships: [],
  groups: [],
}

function useBoard(generation: number, expanded: number | null) {
  const owner = useCanvasBoardOwner('/repo')
  const board = useSyncExternalStore(owner.subscribe, owner.getSnapshot)
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const callbacks = useRef({ report: mock() })
  const dropTargets = useRef<Node[]>([])
  const host = useRef<HTMLDivElement | null>(null)
  useCanvasBoardModel({
    data: board?.data ?? data,
    expanded,
    owner,
    renditionGeneration: generation,
    callbacks,
    selection: emptySelection,
    nodes,
    setNodes,
    edges,
    setEdges,
    target: null,
    dropTargets,
    host,
  })
  return { owner, nodes, callbacks }
}

function setupServices(metadata: CanvasData = data) {
  spyOn(ImageService, 'LoadCanvas').mockImplementation(
    () => Promise.resolve(metadata) as never
  )
  spyOn(ImageService, 'GetLayoutSnapshot').mockImplementation(
    () =>
      Promise.resolve({
        revision: '1',
        images: [{ id: 1, width: 640, height: 480, geometry: rectangle }],
        relationships: [],
      }) as never
  )
  return spyOn(
    ImageService,
    'SetGeometryFromDisplayAtRevision'
  ).mockImplementation(() => Promise.resolve() as never)
}

function resizeCallbacks(node: Node) {
  type Resize = (x: number, y: number, w: number, h: number) => void
  return {
    start: node.data.onResizeStart as Resize,
    end: node.data.onResizeEnd as Resize,
  }
}

afterEach(() => {
  cleanup()
  mock.restore()
})

for (const change of ['rendition', 'expansion'] as const) {
  it(`keeps a submitted resize queued across ${change} changes`, async () => {
    const write = setupServices({
      ...data,
      groups: [
        { id: 42, name: 'Set', kind: 'set', coverImageId: 1, memberIds: [1] },
      ],
    })
    const { result, rerender } = renderHook(
      ({ generation, expanded }) => useBoard(generation, expanded),
      { initialProps: { generation: 0, expanded: 42 as number | null } }
    )
    await act(async () => {
      await result.current.owner.refresh()
    })
    let release = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = result.current.owner.execute(() => blocked)
    const { start, end } = resizeCallbacks(result.current.nodes[0])
    act(() => {
      start(10, 20, 150, 110)
      end(1, 2, 300, 200)
    })
    rerender({
      generation: change === 'rendition' ? 1 : 0,
      expanded: change === 'expansion' ? null : 42,
    })
    expect(result.current.nodes[0].id).toBe('1')
    expect(write).not.toHaveBeenCalled()
    await act(async () => {
      release()
      await first
      await result.current.owner.execute(async () => {})
    })
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(
      '/repo',
      '1',
      [rectangle],
      [rectangle],
      [resized]
    )
    expect(result.current.callbacks.current.report).not.toHaveBeenCalled()
  })
}

for (const invalidation of ['refresh', 'dispose'] as const) {
  it(`cancels a submitted resize when ${invalidation} wins before dispatch`, async () => {
    const write = setupServices()
    const { result, unmount } = renderHook(() => useBoard(0, null))
    await act(async () => {
      await result.current.owner.refresh()
    })
    const owner = result.current.owner
    let release = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = owner.execute(() => blocked)
    const { start, end } = resizeCallbacks(result.current.nodes[0])
    act(() => {
      start(10, 20, 150, 110)
      end(1, 2, 300, 200)
    })
    if (invalidation === 'refresh') {
      await act(async () => {
        await owner.refresh()
      })
    } else unmount()
    await act(async () => {
      release()
      await first
      await owner.execute(async () => {})
    })
    expect(write).not.toHaveBeenCalled()
  })
}

it('cancels an unfinished resize when the renderer is rebuilt', async () => {
  const write = setupServices()
  const { result, rerender } = renderHook(
    ({ generation }) => useBoard(generation, null),
    { initialProps: { generation: 0 } }
  )
  await act(async () => {
    await result.current.owner.refresh()
  })
  const { start, end } = resizeCallbacks(result.current.nodes[0])
  const cancel = spyOn(result.current.owner, 'cancelResize')
  act(() => start(10, 20, 150, 110))
  rerender({ generation: 1 })
  expect(cancel).toHaveBeenCalledTimes(1)
  act(() => {
    end(1, 2, 300, 200)
    start(10, 20, 150, 110)
    end(1, 2, 300, 200)
  })
  await act(async () => {
    await result.current.owner.execute(async () => {})
  })
  expect(write).not.toHaveBeenCalled()
  const current = resizeCallbacks(result.current.nodes[0])
  act(() => {
    current.start(10, 20, 150, 110)
    current.end(1, 2, 300, 200)
  })
  await act(async () => {
    await result.current.owner.execute(async () => {})
  })
  expect(write).toHaveBeenCalledTimes(1)
})
