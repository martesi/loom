import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { Toast } from '@base-ui-components/react/toast'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import type { HistorySelection } from '../../bindings/loom/internal/service'
import { UndoService } from '../../bindings/loom/internal/service'
import type { CanvasBoardExecutor } from '../components/canvas/canvas-board-owner'

mock.module('@lingui/core/macro', () => ({
  t: (parts: TemplateStringsArray) => parts.join(''),
  plural: (count: number, messages: { one: string; other: string }) =>
    (count === 1 ? messages.one : messages.other).replace('#', String(count)),
}))
const { useUndoActions } = await import('./use-undo')

const storagePrefix = 'loom:history-replay:v1:'
const values = new Map<string, string>()
const testStorage = {
  get length() {
    return values.size
  },
  clear() {
    values.clear()
  },
  getItem(key: string) {
    return values.get(key) ?? null
  },
  key(index: number) {
    return [...values.keys()][index] ?? null
  },
  removeItem(key: string) {
    values.delete(key)
  },
  setItem(key: string, value: string) {
    values.set(key, String(value))
  },
} as Storage
const wrapper = ({ children }: { children: React.ReactNode }) =>
  createElement(Toast.Provider, null, children)

beforeEach(() => {
  values.clear()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: testStorage,
  })
  spyOn(UndoService, 'SelectHistoryReplay').mockImplementation(
    async (_repo, direction) => selection(direction)
  )
  spyOn(UndoService, 'ReserveHistoryReplay').mockResolvedValue({
    state: 'reserved',
  } as never)
  spyOn(UndoService, 'ExecuteHistoryReplay').mockResolvedValue({
    state: 'complete',
    result: { applied: false },
  } as never)
  spyOn(UndoService, 'SettleHistoryReplay').mockResolvedValue({
    state: 'sealed',
    result: { applied: false, error: 'sealed' },
  } as never)
})

afterEach(() => {
  cleanup()
  for (let index = testStorage.length - 1; index >= 0; index--) {
    const key = testStorage.key(index)
    if (key?.startsWith(storagePrefix)) testStorage.removeItem(key)
  }
  mock.restore()
})

it('assigns separate IDs to rapid queued Undo and Redo actions', async () => {
  const ids = ['undo-1', 'undo-2', 'redo-1', 'redo-2']
  spyOn(crypto, 'randomUUID').mockImplementation(
    () => ids.shift() ?? 'unexpected'
  )
  let tail = Promise.resolve()
  const executor = {
    isActive: () => true,
    cancelGesture: () => {},
    execute<T>(action: () => Promise<T>) {
      const result = tail.then(action)
      tail = result.then(
        () => undefined,
        () => undefined
      )
      return result
    },
  } satisfies CanvasBoardExecutor
  const firstUndo = deferred<{ state: string; result: { applied: boolean } }>()
  const firstRedo = deferred<{ state: string; result: { applied: boolean } }>()
  const replay = spyOn(UndoService, 'ExecuteHistoryReplay')
    .mockImplementationOnce(() => firstUndo.promise as never)
    .mockResolvedValueOnce(complete({ applied: false }) as never)
    .mockImplementationOnce(() => firstRedo.promise as never)
    .mockResolvedValueOnce(complete({ applied: false }) as never)
  const { result } = renderHook(
    () => useUndoActions('/rapid', () => {}, executor),
    {
      wrapper,
    }
  )

  const undoOne = result.current.undo()
  const undoTwo = result.current.undo()
  await waitFor(() => expect(replay).toHaveBeenCalledTimes(1))
  expect(replay).toHaveBeenCalledWith('/rapid', 'undo-1')
  firstUndo.resolve(complete({ applied: false }))
  await Promise.all([undoOne, undoTwo])
  expect(replay).toHaveBeenNthCalledWith(2, '/rapid', 'undo-2')

  const redoOne = result.current.redo()
  const redoTwo = result.current.redo()
  await waitFor(() => expect(replay).toHaveBeenCalledTimes(3))
  expect(replay).toHaveBeenCalledWith('/rapid', 'redo-1')
  firstRedo.resolve(complete({ applied: false }))
  await Promise.all([redoOne, redoTwo])
  expect(replay).toHaveBeenNthCalledWith(4, '/rapid', 'redo-2')
})

it('persists an uncertain action and retries its ID without issuing another step', async () => {
  spyOn(crypto, 'randomUUID').mockReturnValue('durable-undo')
  const undo = spyOn(UndoService, 'ExecuteHistoryReplay')
    .mockRejectedValueOnce(new Error('response lost'))
    .mockResolvedValueOnce(complete({ applied: true }) as never)
  const { result, unmount } = renderHook(
    () => useUndoActions('/durable', () => {}),
    {
      wrapper,
    }
  )
  const storageKey = `${storagePrefix}${encodeURIComponent('/durable')}:undo`

  await expect(result.current.undo()).rejects.toThrow('response lost')
  expect(testStorage.getItem(storageKey)).toContain('durable-undo')
  await act(async () => result.current.retryUndo())
  expect(undo).toHaveBeenNthCalledWith(1, '/durable', 'durable-undo')
  expect(undo).toHaveBeenNthCalledWith(2, '/durable', 'durable-undo')
  expect(testStorage.getItem(storageKey)).toBeNull()

  undo.mockRejectedValueOnce(new Error('response lost again'))
  await expect(result.current.undo()).rejects.toThrow('response lost again')
  unmount()
  const restored = renderHook(() => useUndoActions('/durable', () => {}), {
    wrapper,
  })
  undo.mockResolvedValueOnce(complete({ applied: false }) as never)
  await act(async () => restored.result.current.undo())
  expect(undo).toHaveBeenLastCalledWith('/durable', 'durable-undo')
  expect(undo).toHaveBeenCalledTimes(4)
  expect(localStorage.getItem(storageKey)).toBeNull()
})

it('does not reuse IDs after a definite failure result', async () => {
  spyOn(crypto, 'randomUUID')
    .mockReturnValueOnce('failed-action')
    .mockReturnValueOnce('next-action')
  const undo = spyOn(UndoService, 'ExecuteHistoryReplay')
    .mockResolvedValueOnce(
      complete({ applied: false, error: 'not available' }) as never
    )
    .mockResolvedValueOnce(complete({ applied: false }) as never)
  const { result } = renderHook(() => useUndoActions('/failure', () => {}), {
    wrapper,
  })
  await act(async () => result.current.undo())
  await act(async () => result.current.undo())
  expect(undo).toHaveBeenNthCalledWith(1, '/failure', 'failed-action')
  expect(undo).toHaveBeenNthCalledWith(2, '/failure', 'next-action')
})

it('keeps the request for a replacement owner after an old owner loses authority', async () => {
  spyOn(crypto, 'randomUUID').mockReturnValue('owner-request')
  const oldResponse = deferred<{
    state: string
    result: { applied: boolean }
  }>()
  const undo = spyOn(UndoService, 'ExecuteHistoryReplay')
    .mockImplementationOnce(() => oldResponse.promise as never)
    .mockResolvedValueOnce(complete({ applied: false }) as never)
  let oldActive = true
  const oldOwner = {
    isActive: () => oldActive,
    execute: <T>(action: () => Promise<T>) => action(),
    cancelGesture: () => {},
  } satisfies CanvasBoardExecutor
  const newOwner = {
    isActive: () => true,
    execute: <T>(action: () => Promise<T>) => action(),
    cancelGesture: () => {},
  } satisfies CanvasBoardExecutor
  const { result, rerender } = renderHook(
    ({ owner }) => useUndoActions('/owner', () => {}, owner),
    { initialProps: { owner: oldOwner }, wrapper }
  )
  const storageKey = `${storagePrefix}${encodeURIComponent('/owner')}:undo`
  const oldAction = result.current.undo()
  await waitFor(() => expect(undo).toHaveBeenCalledTimes(1))
  expect(testStorage.getItem(storageKey)).toContain('owner-request')
  oldActive = false
  rerender({ owner: newOwner })
  oldResponse.resolve(complete({ applied: true }))
  await oldAction
  expect(testStorage.getItem(storageKey)).toContain('owner-request')
  await act(async () => result.current.retryUndo())
  expect(undo).toHaveBeenNthCalledWith(2, '/owner', 'owner-request')
  expect(testStorage.getItem(storageKey)).toBeNull()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function selection(direction: string): HistorySelection {
  return {
    repoPath: '/test',
    direction,
    revision: 1,
    cursor: 1,
    processEpoch: 'epoch',
    sequence: 1,
    kind: 'set_archived',
    forward: '{}',
    inverse: '{}',
    createdAt: 'now',
    noOp: false,
    selectionHash: 'hash',
  }
}

function complete(result: { applied: boolean; error?: string }) {
  return { state: 'complete', result }
}
