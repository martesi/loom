import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { Toast } from '@base-ui-components/react/toast'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { Edge, Node } from '@xyflow/react'
import { createElement, useRef, useState, useSyncExternalStore } from 'react'
import {
  type CanvasData,
  type GeometryUpdate,
  ImageService,
  UndoService,
} from '../../../bindings/loom/internal/service'
import { emptySelection } from '../../lib/selection'
import { useCanvasBoardOwner } from './canvas-board-owner'
import { enqueueCanvasMutation } from './canvas-mutation-queue'
import {
  refreshBoard,
  reserveCanvasOperation,
  reserveCanvasRead,
} from './canvas-operation-test-utils'
import type { ResizeDirection } from './canvas-resize-geometry'
import { useCanvasBoardModel } from './use-canvas-board-model'

mock.module('@lingui/core/macro', () => ({
  t: (parts: TemplateStringsArray) => parts.join(''),
}))
const { useUndoActions } = await import('../../lib/use-undo')

const ignoreSelection = () => {}
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
const toastWrapper = ({ children }: { children: React.ReactNode }) =>
  createElement(Toast.Provider, null, children)

function useBoard(generation: number) {
  const owner = useCanvasBoardOwner('/repo')
  const board = useSyncExternalStore(owner.subscribe, owner.getSnapshot)
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const callbacks = useRef({ report: mock() })
  const host = useRef<HTMLDivElement | null>(null)
  useCanvasBoardModel({
    data: board?.data ?? data,
    owner,
    renditionGeneration: generation,
    callbacks,
    selection: emptySelection,
    setSelection: ignoreSelection,
    nodes,
    setNodes,
    edges,
    setEdges,
    target: null,
    host,
  })
  return { owner, nodes, setNodes, callbacks }
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
  type Start = (
    pointerId: number,
    direction: ResizeDirection,
    before: GeometryUpdate,
    cancelPointer: () => void
  ) => number | null
  type Move = (
    token: number,
    pointerId: number,
    after: GeometryUpdate
  ) => boolean
  type Finish = (
    token: number,
    pointerId: number,
    after: GeometryUpdate
  ) => void
  const start = node.data.onResizeStart as Start
  return {
    start: (
      before = rectangle,
      pointerId = 1,
      direction: ResizeDirection = 'nw'
    ) => start(pointerId, direction, before, () => {}),
    move: node.data.onResizeMove as Move,
    end: node.data.onResizeEnd as Finish,
    cancel: node.data.onResizeCancel as (
      token: number,
      pointerId: number
    ) => void,
  }
}

afterEach(() => {
  cleanup()
  mock.restore()
})

it('keeps a submitted resize queued across rendition changes', async () => {
  const write = setupServices({
    ...data,
    groups: [
      { id: 42, name: 'Set', kind: 'set', coverImageId: 1, memberIds: [1] },
    ],
  })
  const { result, rerender } = renderHook(
    ({ generation }) => useBoard(generation),
    { initialProps: { generation: 0 } }
  )
  if (result.error) throw result.error
  await act(async () => {
    await refreshBoard(result.current.owner)
  })
  const { start, end } = resizeCallbacks(result.current.nodes[0])
  let token = 0
  act(() => {
    token = start(rectangle) ?? 0
  })
  let release = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let signalStarted = () => {}
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  const first = reserveCanvasRead(result.current.owner, async () => {
    signalStarted()
    await blocked
  })
  await started
  await Promise.resolve()
  act(() => {
    end(token, 1, resized)
  })
  rerender({ generation: 1 })
  expect(result.current.nodes[0].id).toBe('1')
  expect(write).not.toHaveBeenCalled()
  await act(async () => {
    release()
    expect((await first).status).toBe('success')
  })
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
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

for (const invalidation of ['refresh', 'dispose'] as const) {
  it(`preserves a submitted resize across ${invalidation} while respecting owner lifetime`, async () => {
    const write = setupServices()
    const { result, unmount } = renderHook(() => useBoard(0, null))
    await act(async () => {
      await refreshBoard(result.current.owner)
    })
    const owner = result.current.owner
    const { start, end } = resizeCallbacks(result.current.nodes[0])
    let token = 0
    act(() => {
      token = start(rectangle) ?? 0
    })
    let release = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let signalStarted = () => {}
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    const first = reserveCanvasRead(owner, async () => {
      signalStarted()
      await blocked
    })
    await started
    await Promise.resolve()
    act(() => {
      end(token, 1, resized)
    })
    const refresh = invalidation === 'refresh' ? owner.refresh() : null
    if (invalidation === 'dispose') unmount()
    await act(async () => {
      release()
      expect((await first).status).toBe(
        invalidation === 'refresh' ? 'success' : 'cancelled'
      )
    })
    if (refresh) await refresh
    if (invalidation === 'refresh') expect(write).toHaveBeenCalledTimes(1)
    else expect(write).not.toHaveBeenCalled()
  })
}

it('cancels an unfinished resize when the renderer is rebuilt', async () => {
  const write = setupServices()
  const { result, rerender } = renderHook(
    ({ generation }) => useBoard(generation, null),
    { initialProps: { generation: 0 } }
  )
  await act(async () => {
    await refreshBoard(result.current.owner)
  })
  const { start, end } = resizeCallbacks(result.current.nodes[0])
  const cancel = spyOn(result.current.owner, 'cancelResize')
  let token = 0
  act(() => {
    token = start(rectangle) ?? 0
  })
  rerender({ generation: 1 })
  expect(cancel).toHaveBeenCalledTimes(1)
  act(() => end(token, 1, resized))
  await act(async () => {
    await reserveCanvasOperation(result.current.owner, async () => {})
  })
  expect(write).not.toHaveBeenCalled()
  const current = resizeCallbacks(result.current.nodes[0])
  let currentToken = 0
  act(() => {
    currentToken = current.start(rectangle) ?? 0
    current.end(currentToken, 1, resized)
  })
  await act(async () => {
    await reserveCanvasOperation(result.current.owner, async () => {})
  })
  expect(write).toHaveBeenCalledTimes(1)
})

it('rejects resize starts during a pending layout and accepts a fresh pointer later', async () => {
  const write = setupServices()
  const { result } = renderHook(() => useBoard(0))
  await act(async () => {
    await refreshBoard(result.current.owner)
  })
  let releaseLayout = () => {}
  const layoutGate = new Promise<void>((resolve) => {
    releaseLayout = resolve
  })
  const layout = reserveCanvasOperation(result.current.owner, () => layoutGate)
  await Promise.resolve()
  const { start, cancel } = resizeCallbacks(result.current.nodes[0])
  expect(start(rectangle, 7)).toBeNull()
  releaseLayout()
  expect((await layout).status).toBe('success')
  expect(result.current.owner.isLayoutPending()).toBe(false)
  const token = start(rectangle, 8)
  expect(token).not.toBeNull()
  if (token === null) throw new Error('fresh pointer was rejected')
  act(() => cancel(token, 8))
  expect(result.current.nodes[0].width).toBe(150)
  expect(result.current.nodes[0].height).toBe(110)
  expect(write).not.toHaveBeenCalled()
})

for (const capability of ['relationship', 'geometry'] as const) {
  it(`restores and rejects late pointer events after a ${capability} command`, async () => {
    const write = setupServices()
    const { result } = renderHook(() => useBoard(0))
    await act(async () => {
      await refreshBoard(result.current.owner)
    })
    await result.current.owner.submit(
      { kind: 'mode', target: 'edit' },
      async (context) => context.setMode('edit')
    )
    const { start, move, end } = resizeCallbacks(result.current.nodes[0])
    let token = 0
    act(() => {
      token = start(rectangle, 11) ?? 0
      move(token, 11, resized)
    })
    await act(async () => {
      await enqueueCanvasMutation(
        result.current.owner,
        capability,
        async () => {}
      )
    })
    expect(result.current.nodes[0].position).toEqual({ x: 10, y: 20 })
    expect(result.current.nodes[0].width).toBe(150)
    expect(result.current.nodes[0].height).toBe(110)
    expect(move(token, 11, resized)).toBe(false)
    end(token, 11, resized)
    expect(write).not.toHaveBeenCalled()
  })
}

it('undo cancels an active resize and prevents its final dimensions from writing', async () => {
  const write = setupServices()
  const undo = spyOn(UndoService, 'Undo').mockResolvedValue({
    applied: false,
    error: '',
  } as never)
  const redo = spyOn(UndoService, 'Redo').mockResolvedValue({
    applied: false,
    error: '',
  } as never)
  const { result } = renderHook(() => useBoard(0))
  await act(async () => {
    await refreshBoard(result.current.owner)
  })
  await result.current.owner.submit(
    { kind: 'mode', target: 'edit' },
    async (context) => context.setMode('edit')
  )
  const { start, move, end } = resizeCallbacks(result.current.nodes[0])
  let token = 0
  act(() => {
    token = start(rectangle, 12) ?? 0
    move(token, 12, resized)
  })
  const actions = renderHook(
    () => useUndoActions('/repo', result.current.owner),
    { wrapper: toastWrapper }
  )
  await act(async () => actions.result.current.undo())
  expect(undo).toHaveBeenCalledTimes(1)
  expect(result.current.nodes[0].position).toEqual({ x: 10, y: 20 })
  expect(result.current.nodes[0].width).toBe(150)
  expect(result.current.nodes[0].height).toBe(110)
  expect(move(token, 12, resized)).toBe(false)
  end(token, 12, resized)

  const second = resizeCallbacks(result.current.nodes[0])
  const secondToken = second.start(rectangle, 13)
  if (secondToken === null) throw new Error('redo resize was rejected')
  expect(second.move(secondToken, 13, resized)).toBe(true)
  await act(async () => actions.result.current.redo())
  expect(redo).toHaveBeenCalledTimes(1)
  expect(result.current.nodes[0].position).toEqual({ x: 10, y: 20 })
  expect(result.current.nodes[0].width).toBe(150)
  expect(result.current.nodes[0].height).toBe(110)
  second.end(secondToken, 13, resized)
  expect(write).not.toHaveBeenCalled()
})
