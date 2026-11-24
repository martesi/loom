import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Toast } from '@base-ui-components/react/toast'
import {
  act,
  cleanup,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import type { Edge, Node, ReactFlowInstance } from '@xyflow/react'
import { createElement, useRef, useState } from 'react'
import {
  type CanvasData,
  ImageService,
  UndoService,
} from '../../../bindings/loom/internal/service'
import { emptySelection } from '../../lib/selection'
import { Toaster } from '../ui/toast'
import { useCanvasBoardOwner } from './canvas-board-owner'
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
  const [boardData, setData] = useState(data)
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
    setData,
    setRefresh,
    setError,
    setReady: noOp,
    setAssetSelectionRecords: noOp,
  })
  const callbacks = useRef({ run: repository.run })
  callbacks.current = { run: repository.run }
  const dropTargets = useRef<Node[]>([])
  const host = useRef<HTMLDivElement | null>(null)
  useCanvasBoardModel({
    data: boardData,
    expanded: null,
    repoPath,
    renditionGeneration: 0,
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
  const undo = useUndoActions(repoPath, repository.reload, owner)
  return { owner, repository, nodes, undo, error }
}

afterEach(() => {
  cleanup()
  mock.restore()
})

describe('canvas board owner', () => {
  it('waits for the real resize commit and its reload before undo, then waits for undo reload before redo', async () => {
    const resize = deferred<void>()
    const reload = deferred<CanvasData | null>()
    const undoReload = deferred<CanvasData | null>()
    const geometry = spyOn(ImageService, 'SetGeometry').mockImplementation(
      () => resize.promise as never
    )
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
    await waitFor(() => expect(result.current.nodes).toHaveLength(1))
    act(() => {
      const onResizeEnd = result.current.nodes[0].data.onResizeEnd as (
        x: number,
        y: number,
        w: number,
        h: number
      ) => void
      onResizeEnd(1, 2, 300, 200)
    })
    const undoDone = result.current.undo.undo()
    const redoDone = result.current.undo.redo()
    await waitFor(() => expect(geometry).toHaveBeenCalledTimes(1))
    expect(geometry).toHaveBeenCalledWith('/repo', [
      { imageId: 1, x: 1, y: 2, w: 300, h: 200 },
    ])
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

  it('preserves errors and continues after a rejected operation', async () => {
    const { result } = renderHook(() => useCanvasBoardOwner('/repo'))
    const failure = deferred<number>()
    const first = result.current.execute(() => failure.promise)
    const second = result.current.execute(() => Promise.resolve(42))
    const error = new Error('commit failed')
    failure.reject(error)
    await expect(first).rejects.toBe(error)
    await expect(second).resolves.toBe(42)
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
    const pending = deferred<void>()
    const error = new Error('resize failed')
    act(() => result.current.repository.run(() => pending.promise))
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

  it('propagates a failed undo reload and continues with queued redo', async () => {
    const error = new Error('reload failed')
    const reload = deferred<CanvasData | null>()
    spyOn(ImageService, 'LoadCanvas')
      .mockImplementationOnce(() => Promise.resolve(data) as never)
      .mockImplementationOnce(() => reload.promise as never)
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
    expect(await failure).toBe(error)
    await act(async () => {
      await redoDone
    })
    expect(redo).toHaveBeenCalledTimes(1)
  })

  it('keeps undo errors in a toast and does not reload when nothing applied', async () => {
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
    expect(ImageService.LoadCanvas).toHaveBeenCalledTimes(1)
  })

  it('awaits callbacks without an executor and preserves callback rejection', async () => {
    spyOn(UndoService, 'Undo').mockImplementation(
      () => Promise.resolve({ applied: true, error: '' }) as never
    )
    const change = deferred<void>()
    const { result } = renderHook(
      () => useUndoActions('/repo', () => change.promise),
      { wrapper }
    )
    const done = result.current.undo()
    const error = new Error('reload failed')
    change.reject(error)
    await expect(done).rejects.toBe(error)
  })

  it('keeps an owner across renders and disposes its identity when the repository changes', async () => {
    const { result, rerender, unmount } = renderHook(
      ({ path }) => useCanvasBoardOwner(path),
      { initialProps: { path: '/one' } }
    )
    const first = result.current
    const pending = deferred<void>()
    const blocked = first.execute(() => pending.promise)
    rerender({ path: '/one' })
    expect(result.current).toBe(first)
    rerender({ path: '/two' })
    expect(result.current).not.toBe(first)
    await expect(
      result.current.execute(() => Promise.resolve('ready'))
    ).resolves.toBe('ready')
    rerender({ path: '/one' })
    expect(result.current).not.toBe(first)
    unmount()
    pending.resolve()
    await blocked
  })
})
