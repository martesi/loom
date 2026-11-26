import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { Toast } from '@base-ui-components/react/toast'
import {
  act,
  cleanup,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { Call } from '@wailsio/runtime'
import type { Edge, Node, ReactFlowInstance } from '@xyflow/react'
import { createElement, useRef, useState, useSyncExternalStore } from 'react'
import {
  type CanvasData,
  type GeometryUpdate,
  ImageService,
  UndoService,
} from '../../../bindings/loom/internal/service'
import { emptySelection } from '../../lib/selection'
import { Toaster } from '../ui/toast'
import {
  createCanvasBoardOwner,
  useCanvasBoardOwner,
} from './canvas-board-owner'
import { isCanvasRepositoryDirty } from './canvas-operation'
import { canvasEffects } from './canvas-operation-effects'
import {
  refreshBoard,
  reserveCanvasOperation,
  reserveCanvasRead,
} from './canvas-operation-test-utils'
import type { ResizeDirection } from './canvas-resize-geometry'
import { useCanvasBoardModel } from './use-canvas-board-model'
import { useCanvasRepository } from './use-canvas-repository'

mock.module('@lingui/core/macro', () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (message, part, index) =>
        `${message}${part}${String(values[index] ?? '')}`,
      ''
    ),
  plural: (count: number, messages: { one: string; other: string }) =>
    (count === 1 ? messages.one : messages.other).replace('#', String(count)),
}))
const { useUndoActions } = await import('../../lib/use-undo')
const ignoreSelection = () => {}

function resizeStart(node: Node, before: GeometryUpdate, pointerId = 1) {
  const start = node.data.onResizeStart as (
    pointerId: number,
    direction: ResizeDirection,
    before: GeometryUpdate,
    cancelPointer: () => void
  ) => number | null
  return start(pointerId, 'nw', before, () => {})
}

function resizeEnd(
  node: Node,
  token: number,
  after: GeometryUpdate,
  pointerId = 1
) {
  const end = node.data.onResizeEnd as (
    token: number,
    pointerId: number,
    after: GeometryUpdate
  ) => void
  end(token, pointerId, after)
}

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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

const flow = {
  setViewport: mock(),
  fitView: mock(),
} as unknown as ReactFlowInstance
const noOp = () => {}
const wrapper = ({ children }: { children: React.ReactNode }) =>
  createElement(Toast.Provider, null, children, createElement(Toaster))

function useBoard(repoPath: string) {
  const owner = useCanvasBoardOwner(repoPath)
  const boardData =
    useSyncExternalStore(owner.subscribe, owner.getSnapshot)?.data ?? data
  const [refresh, setRefresh] = useState(0)
  const [error, setError] = useState('')
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const repository = useCanvasRepository({
    repoPath,
    executor: owner,
    flow,
    updateZoomCompensation: noOp,
    selection: emptySelection,
    refresh,
    setRefresh,
    setError,
    setReady: noOp,
    setAssetSelectionRecords: noOp,
  })
  const callbacks = useRef({ report: repository.report })
  callbacks.current = { report: repository.report }
  const host = useRef<HTMLDivElement | null>(null)
  useCanvasBoardModel({
    data: boardData,
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
  })
  const undo = useUndoActions(repoPath, owner)
  return { owner, repository, nodes, undo, error }
}

beforeEach(() => {
  spyOn(ImageService, 'GetLayoutSnapshot').mockImplementation(
    () =>
      Promise.resolve({
        revision: '1',
        images: [
          {
            id: 1,
            width: 640,
            height: 480,
            geometry: { imageId: 1, x: 10, y: 20, w: 150, h: 110 },
          },
        ],
        relationships: [],
      }) as never
  )
})

afterEach(() => {
  cleanup()
  mock.restore()
})

describe('canvas board owner', () => {
  it('keeps a held resize active across queued passive viewport saves', async () => {
    const repoPath = '/repo-passive-viewport-resize'
    spyOn(ImageService, 'LoadCanvas').mockResolvedValue(data as never)
    spyOn(ImageService, 'GetViewport').mockResolvedValue(null as never)
    const viewportResponse = deferred<void>()
    const events: string[] = []
    let viewportWrites = 0
    const viewport = spyOn(ImageService, 'SetViewport').mockImplementation(
      () => {
        viewportWrites++
        events.push(`viewport-${viewportWrites}`)
        return viewportResponse.promise as never
      }
    )
    const geometry = spyOn(
      ImageService,
      'SetGeometryFromDisplayAtRevision'
    ).mockImplementation(() => {
      events.push('geometry')
      return Promise.resolve() as never
    })
    const { result } = renderHook(() => useBoard(repoPath), { wrapper })
    await waitFor(() =>
      expect(result.current.owner.getSnapshot()).not.toBeNull()
    )
    const owner = result.current.owner
    const board = owner.getSnapshot()
    const before = { imageId: 1, x: 10, y: 20, w: 150, h: 110 }
    const after = { imageId: 1, x: 10, y: 20, w: 210, h: 160 }
    const token = owner.beginResize(
      board,
      before,
      'se',
      4,
      () => {},
      () => {}
    )
    if (token === null) throw new Error('resize start rejected')

    const passiveViewport = () =>
      owner.submit({ kind: 'viewport', mode: 'legacy', board }, (context) =>
        canvasEffects.setViewport(context, repoPath, {
          x: 0,
          y: 0,
          zoom: 1.5,
        })
      )
    const firstSave = passiveViewport()
    await waitFor(() => expect(viewport).toHaveBeenCalledTimes(1))
    const secondSave = passiveViewport()
    expect(owner.updateResize(token, 4, after)).toBe(true)
    expect(owner.isLayoutPending()).toBe(false)
    expect(isCanvasRepositoryDirty(repoPath)).toBe(false)
    expect(geometry).not.toHaveBeenCalled()

    viewportResponse.resolve()
    expect((await firstSave).status).toBe('success')
    await waitFor(() => expect(viewport).toHaveBeenCalledTimes(2))
    expect((await secondSave).status).toBe('success')
    expect(owner.updateResize(token, 4, after)).toBe(true)
    expect(owner.isLayoutPending()).toBe(false)
    expect(isCanvasRepositoryDirty(repoPath)).toBe(false)

    const resize = owner.endResize(token, 4, after)
    expect(geometry).not.toHaveBeenCalled()
    expect((await resize).status).toBe('success')
    expect(viewport).toHaveBeenCalledTimes(2)
    expect(events).toEqual(['viewport-1', 'viewport-2', 'geometry'])
    expect(isCanvasRepositoryDirty(repoPath)).toBe(false)
    owner.dispose()
  })

  it('cancels a held resize when an explicit viewport action is admitted', async () => {
    const repoPath = '/repo-explicit-viewport-resize'
    spyOn(ImageService, 'LoadCanvas').mockResolvedValue(data as never)
    spyOn(ImageService, 'GetViewport').mockResolvedValue(null as never)
    const viewport = spyOn(ImageService, 'SetViewport').mockResolvedValue(
      undefined as never
    )
    const owner = createCanvasBoardOwner(repoPath)
    expect((await owner.activate()).status).toBe('success')
    const before = { imageId: 1, x: 10, y: 20, w: 150, h: 110 }
    const cancelled = mock()
    const token = owner.beginResize(
      owner.getSnapshot(),
      before,
      'se',
      5,
      () => {},
      cancelled
    )
    if (token === null) throw new Error('resize start rejected')

    const action = owner.submit(
      {
        kind: 'mutation',
        capability: 'navigate',
        board: owner.getSnapshot(),
      },
      (context) =>
        canvasEffects.setViewport(context, repoPath, {
          x: 20,
          y: 30,
          zoom: 1,
        })
    )

    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(owner.updateResize(token, 5, { ...before, w: 190 })).toBe(false)
    expect((await action).status).toBe('success')
    expect(viewport).toHaveBeenCalledTimes(1)
    owner.dispose()
  })

  it('waits for the real resize commit and its reload before undo, then waits for undo reload before redo', async () => {
    spyOn(ImageService, 'GetLayoutSnapshot').mockImplementation(
      () =>
        Promise.resolve({
          revision: '1',
          images: [
            {
              id: 1,
              width: 640,
              height: 480,
              geometry: { imageId: 1, x: 10, y: 20, w: null, h: null },
            },
          ],
          relationships: [],
        }) as never
    )
    const resize = deferred<void>()
    const reload = deferred<CanvasData | null>()
    const undoReload = deferred<CanvasData | null>()
    const geometry = spyOn(
      ImageService,
      'SetGeometryFromDisplayAtRevision'
    ).mockImplementation(() => resize.promise as never)
    const load = spyOn(ImageService, 'LoadCanvas')
      .mockImplementationOnce(() => Promise.resolve(data) as never)
      .mockImplementationOnce(() => reload.promise as never)
      .mockImplementationOnce(() => undoReload.promise as never)
      .mockImplementation(() => Promise.resolve(data) as never)
    spyOn(ImageService, 'GetViewport').mockImplementation(
      () => Promise.resolve(null) as never
    )
    const undo = spyOn(UndoService, 'Undo').mockImplementation(
      () => Promise.resolve({ applied: true, error: '' }) as never
    )
    const redo = spyOn(UndoService, 'Redo').mockImplementation(
      () => Promise.resolve({ applied: true, error: '' }) as never
    )
    const { result } = renderHook(() => useBoard('/repo'), { wrapper })
    await waitFor(() =>
      expect(result.current.owner.getSnapshot()).not.toBeNull()
    )
    await waitFor(() => expect(result.current.nodes).toHaveLength(1))
    act(() => {
      const node = result.current.nodes[0]
      const token = resizeStart(node, {
        imageId: 1,
        x: 10,
        y: 20,
        w: 150,
        h: 110,
      })
      if (token === null) throw new Error('resize start rejected')
      resizeEnd(node, token, { imageId: 1, x: 1, y: 2, w: 300, h: 200 })
    })
    const undoDone = result.current.undo.undo()
    const redoDone = result.current.undo.redo()
    await waitFor(() => expect(geometry).toHaveBeenCalledTimes(1))
    expect(geometry).toHaveBeenCalledWith(
      '/repo',
      '1',
      [{ imageId: 1, x: 10, y: 20, w: null, h: null }],
      [{ imageId: 1, x: 10, y: 20, w: 150, h: 110 }],
      [{ imageId: 1, x: 1, y: 2, w: 300, h: 200 }]
    )
    expect(undo).not.toHaveBeenCalled()
    resize.resolve()
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    expect(undo).not.toHaveBeenCalled()
    reload.resolve(data)
    await waitFor(() => expect(undo).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3))
    expect(redo).not.toHaveBeenCalled()
    undoReload.resolve(data)
    await act(async () => {
      await Promise.all([undoDone, redoDone])
    })
    expect(redo).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(4)
  })

  it('cancels a resize at refresh start and ignores its late end', async () => {
    const pending = deferred<CanvasData | null>()
    spyOn(ImageService, 'LoadCanvas')
      .mockImplementationOnce(() => Promise.resolve(data) as never)
      .mockImplementationOnce(() => pending.promise as never)
    spyOn(ImageService, 'GetViewport').mockImplementation(
      () => Promise.resolve(null) as never
    )
    const write = spyOn(
      ImageService,
      'SetGeometryFromDisplayAtRevision'
    ).mockImplementation(() => Promise.resolve() as never)
    const { result } = renderHook(() => useBoard('/repo'), { wrapper })
    await waitFor(() =>
      expect(result.current.owner.getSnapshot()).not.toBeNull()
    )
    const node = result.current.nodes[0]
    const token = resizeStart(node, {
      imageId: 1,
      x: 10,
      y: 20,
      w: 150,
      h: 110,
    })
    if (token === null) throw new Error('resize start rejected')
    let refreshing!: Promise<void>
    act(() => {
      refreshing = result.current.repository.reload()
    })
    act(() =>
      resizeEnd(node, token, { imageId: 1, x: 1, y: 2, w: 300, h: 200 })
    )
    pending.resolve(data)
    await act(async () => {
      await refreshing
    })
    expect(result.current.error).toBe('')
    act(() =>
      resizeEnd(node, token, { imageId: 1, x: 1, y: 2, w: 300, h: 200 })
    )
    expect(write).not.toHaveBeenCalled()
    expect(result.current.error).toBe('')
  })

  it('reloads and reports a stale resize without adding history', async () => {
    spyOn(ImageService, 'LoadCanvas').mockImplementation(
      () => Promise.resolve(data) as never
    )
    spyOn(ImageService, 'GetViewport').mockImplementation(
      () => Promise.resolve(null) as never
    )
    const error = new Call.RuntimeError('stale layout revision; reload canvas')
    spyOn(console, 'error').mockImplementation(() => {})
    const write = spyOn(
      ImageService,
      'SetGeometryFromDisplayAtRevision'
    ).mockImplementation(() => Promise.reject(error) as never)
    const { result } = renderHook(() => useBoard('/repo'), { wrapper })
    await waitFor(() =>
      expect(result.current.owner.getSnapshot()).not.toBeNull()
    )
    const node = result.current.nodes[0]
    const token = resizeStart(node, {
      imageId: 1,
      x: 10,
      y: 20,
      w: 150,
      h: 110,
    })
    if (token === null) throw new Error('resize start rejected')
    act(() =>
      resizeEnd(node, token, { imageId: 1, x: 1, y: 2, w: 300, h: 200 })
    )
    await waitFor(() => expect(result.current.error).toBe(error.message))
    expect(write).toHaveBeenCalledTimes(1)
    expect(ImageService.LoadCanvas).toHaveBeenCalledTimes(2)
  })

  it('skips an unchanged rectangle before queued redo', async () => {
    spyOn(ImageService, 'LoadCanvas').mockImplementation(
      () => Promise.resolve(data) as never
    )
    spyOn(ImageService, 'GetViewport').mockImplementation(
      () => Promise.resolve(null) as never
    )
    const write = spyOn(
      ImageService,
      'SetGeometryFromDisplayAtRevision'
    ).mockImplementation(() => Promise.resolve() as never)
    const redo = spyOn(UndoService, 'Redo').mockImplementation(
      () => Promise.resolve({ applied: false, error: '' }) as never
    )
    const { result } = renderHook(() => useBoard('/repo'), { wrapper })
    await waitFor(() =>
      expect(result.current.owner.getSnapshot()).not.toBeNull()
    )
    const node = result.current.nodes[0]
    const token = resizeStart(node, {
      imageId: 1,
      x: 10,
      y: 20,
      w: 150,
      h: 110,
    })
    if (token === null) throw new Error('resize start rejected')
    act(() =>
      resizeEnd(node, token, { imageId: 1, x: 10, y: 20, w: 150, h: 110 })
    )
    await act(async () => {
      await result.current.undo.redo()
    })
    expect(write).not.toHaveBeenCalled()
    expect(redo).toHaveBeenCalledTimes(1)
  })

  it('preserves errors and continues after a rejected operation', async () => {
    spyOn(ImageService, 'LoadCanvas').mockResolvedValue(data as never)
    spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
      revision: '1',
      images: [
        {
          id: 1,
          width: 640,
          height: 480,
          geometry: { imageId: 1, x: 10, y: 20, w: 150, h: 110 },
        },
      ],
      relationships: [],
    } as never)
    const { result } = renderHook(() => useCanvasBoardOwner('/repo'))
    await refreshBoard(result.current)
    const failure = deferred<number>()
    const first = reserveCanvasOperation(result.current, () => failure.promise)
    const second = reserveCanvasOperation(result.current, async () => 42)
    const error = new Error('commit failed')
    failure.reject(error)
    expect(await first).toMatchObject({ status: 'failed', error })
    expect(await second).toMatchObject({ status: 'success', value: 42 })
  })

  it('reports failed repository operations and still runs queued undo', async () => {
    spyOn(ImageService, 'LoadCanvas').mockImplementation(
      () => Promise.resolve(data) as never
    )
    spyOn(ImageService, 'GetViewport').mockImplementation(
      () => Promise.resolve(null) as never
    )
    const log = spyOn(console, 'error').mockImplementation(() => {})
    const undo = spyOn(UndoService, 'Undo').mockImplementation(
      () => Promise.resolve({ applied: false, error: '' }) as never
    )
    const { result } = renderHook(() => useBoard('/repo'), { wrapper })
    await waitFor(() => expect(result.current.nodes).toHaveLength(1))
    const pending = deferred<void>()
    let signalStarted = () => {}
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    const error = new Error('resize failed')
    act(() =>
      result.current.repository.run(() => {
        signalStarted()
        return pending.promise
      })
    )
    await started
    const undoDone = result.current.undo.undo()
    pending.reject(error)
    await act(async () => {
      await undoDone
    })
    await waitFor(() =>
      expect(log).toHaveBeenCalledWith('canvas operation failed', error)
    )
    expect(result.current.error).toBe('resize failed')
    expect(undo).toHaveBeenCalledTimes(1)
  })

  it('fences queued redo after a failed history reload until recovery', async () => {
    const error = new Error('reload failed')
    const reload = deferred<CanvasData | null>()
    spyOn(ImageService, 'LoadCanvas')
      .mockImplementationOnce(() => Promise.resolve(data) as never)
      .mockImplementationOnce(() => reload.promise as never)
      .mockResolvedValue(data as never)
    spyOn(ImageService, 'GetViewport').mockImplementation(
      () => Promise.resolve(null) as never
    )
    spyOn(UndoService, 'Undo').mockImplementation(
      () => Promise.resolve({ applied: true, error: '' }) as never
    )
    const redo = spyOn(UndoService, 'Redo').mockImplementation(
      () => Promise.resolve({ applied: false, error: '' }) as never
    )
    const { result } = renderHook(() => useBoard('/repo'), { wrapper })
    await waitFor(() => expect(result.current.nodes).toHaveLength(1))
    const undoDone = result.current.undo.undo()
    const failure = undoDone.then(
      () => null,
      (reason: unknown) => reason
    )
    const redoDone = result.current.undo.redo()
    await waitFor(() =>
      expect(ImageService.LoadCanvas).toHaveBeenCalledTimes(2)
    )
    expect(redo).not.toHaveBeenCalled()
    reload.reject(error)
    expect(await failure).toMatchObject({
      message: expect.stringContaining('reload failed'),
    })
    expect(
      await redoDone.then(
        () => null,
        (reason: unknown) => reason
      )
    ).toMatchObject({
      message: expect.stringContaining('Canvas was refreshed'),
    })
    expect(redo).not.toHaveBeenCalled()
    expect(ImageService.LoadCanvas).toHaveBeenCalledTimes(3)
  })

  it('keeps undo errors in a toast after reconciling a no-op result', async () => {
    spyOn(ImageService, 'LoadCanvas').mockImplementation(
      () => Promise.resolve(data) as never
    )
    spyOn(ImageService, 'GetViewport').mockImplementation(
      () => Promise.resolve(null) as never
    )
    spyOn(UndoService, 'Undo').mockImplementation(
      () =>
        Promise.resolve({ applied: false, error: 'asset was purged' }) as never
    )
    const { result } = renderHook(() => useBoard('/repo'), { wrapper })
    await waitFor(() => expect(result.current.nodes).toHaveLength(1))
    await act(async () => {
      await result.current.undo.undo()
    })
    expect(screen.getByText('asset was purged')).toBeTruthy()
    expect(ImageService.LoadCanvas).toHaveBeenCalledTimes(2)
  })

  it('preserves a history service error after authoritative recovery', async () => {
    const error = new Call.RuntimeError('undo failed')
    const load = spyOn(ImageService, 'LoadCanvas').mockResolvedValue(
      data as never
    )
    spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
      revision: '1',
      images: [
        {
          id: 1,
          width: 640,
          height: 480,
          geometry: { imageId: 1, x: 10, y: 20, w: 150, h: 110 },
        },
      ],
      relationships: [],
    } as never)
    spyOn(UndoService, 'Undo').mockRejectedValue(error as never)
    const owner = createCanvasBoardOwner('/repo')
    await refreshBoard(owner)
    const { result } = renderHook(() => useUndoActions('/repo', owner), {
      wrapper,
    })
    await expect(result.current.undo()).rejects.toBe(error)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps an owner across renders and disposes its identity when the repository changes', async () => {
    spyOn(ImageService, 'LoadCanvas').mockResolvedValue(data as never)
    spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
      revision: '1',
      images: [
        {
          id: 1,
          width: 640,
          height: 480,
          geometry: { imageId: 1, x: 10, y: 20, w: 150, h: 110 },
        },
      ],
      relationships: [],
    } as never)
    const { result, rerender, unmount } = renderHook(
      ({ path }) => useCanvasBoardOwner(path),
      { initialProps: { path: '/one' } }
    )
    const first = result.current
    await refreshBoard(first)
    const pending = deferred<void>()
    const blocked = reserveCanvasRead(first, () => pending.promise)
    rerender({ path: '/one' })
    expect(result.current).toBe(first)
    rerender({ path: '/two' })
    expect(result.current).not.toBe(first)
    await refreshBoard(result.current)
    expect(
      await reserveCanvasRead(result.current, async () => 'ready')
    ).toMatchObject({ status: 'success', value: 'ready' })
    rerender({ path: '/one' })
    expect(result.current).not.toBe(first)
    unmount()
    pending.resolve()
    expect(await blocked).toMatchObject({ status: 'cancelled' })
  })
})
