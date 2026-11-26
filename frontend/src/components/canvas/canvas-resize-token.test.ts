import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import {
  type GeometryUpdate,
  ImageService,
} from '../../../bindings/loom/internal/service'
import {
  createCanvasBoardOwner,
  useCanvasBoardOwner,
} from './canvas-board-owner'
import { refreshBoard } from './canvas-operation-test-utils'

const rectangle: GeometryUpdate = { imageId: 1, x: 10, y: 20, w: 150, h: 110 }
const resized: GeometryUpdate = { ...rectangle, x: 1, y: 2, w: 300, h: 200 }

function setup() {
  spyOn(ImageService, 'LoadCanvas').mockResolvedValue({
    images: [{ id: 1 }],
    relationships: [],
    groups: [],
  } as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
    revision: '1',
    relationships: [],
    images: [{ id: 1, width: 640, height: 480, geometry: rectangle }],
  } as never)
  return spyOn(
    ImageService,
    'SetGeometryFromDisplayAtRevision'
  ).mockResolvedValue(undefined as never)
}

afterEach(() => {
  cleanup()
  mock.restore()
})

it('binds updates to one pointer and token, and allows a fresh resize after cancellation', async () => {
  const write = setup()
  const owner = createCanvasBoardOwner('/repo')
  const board = await refreshBoard(owner)
  owner.setMode('edit')
  const cancel = mock()
  const preview = mock()
  const first = owner.beginResize(board, rectangle, 'nw', 44, preview, cancel)
  if (first === null) throw new Error('first pointer was rejected')
  expect(
    owner.beginResize(board, rectangle, 'se', 45, preview, mock())
  ).toBeNull()
  expect(owner.updateResize(first, 45, resized)).toBe(false)
  expect(owner.updateResize(first, 44, resized)).toBe(true)
  expect(preview).toHaveBeenCalledWith(resized)
  owner.cancelResize(first, 44)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(owner.updateResize(first, 44, resized)).toBe(false)
  const next = owner.beginResize(board, rectangle, 'nw', 44, preview, mock())
  if (next === null) throw new Error('fresh resize was rejected')
  expect(next).toBeGreaterThan(first)
  expect(owner.updateResize(first, 44, resized)).toBe(false)
  expect(await owner.endResize(next, 44, resized)).toMatchObject({
    status: 'success',
  })
  expect(write).toHaveBeenCalledTimes(1)
  owner.dispose()
})

it('invalidates active tokens on transition, refresh, dispose, and StrictMode cleanup', async () => {
  const write = setup()
  const owner = createCanvasBoardOwner('/repo')
  let board = await refreshBoard(owner)
  owner.setMode('edit')
  const cancelled = mock()
  const start = () =>
    owner.beginResize(board, rectangle, 'n', 9, mock(), cancelled)
  const transition = start()
  if (transition === null) throw new Error('transition resize was rejected')
  owner.beginModeTransition()
  expect(owner.updateResize(transition, 9, resized)).toBe(false)
  expect(cancelled).toHaveBeenCalledTimes(1)

  const refresh = start()
  if (refresh === null) throw new Error('refresh resize was rejected')
  board = await refreshBoard(owner)
  expect(owner.updateResize(refresh, 9, resized)).toBe(false)

  const strictWrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(StrictMode, null, children)
  const hook = renderHook(() => useCanvasBoardOwner('/repo'), {
    wrapper: strictWrapper,
  })
  const strictOwner = hook.result.current
  const strictBoard = await refreshBoard(strictOwner)
  const strictToken = strictOwner.beginResize(
    strictBoard,
    rectangle,
    'w',
    9,
    mock(),
    mock()
  )
  if (strictToken === null) throw new Error('StrictMode resize was rejected')
  await act(async () => hook.unmount())
  strictOwner.activate()
  expect(strictOwner.updateResize(strictToken, 9, resized)).toBe(false)
  await refreshBoard(strictOwner)
  const reactivated = strictOwner.beginResize(
    strictOwner.getSnapshot(),
    rectangle,
    'w',
    9,
    mock(),
    mock()
  )
  if (reactivated === null) throw new Error('reactivated resize was rejected')
  expect(reactivated).toBeGreaterThan(strictToken)
  strictOwner.cancelResize(reactivated, 9)

  const repoHook = renderHook(({ path }) => useCanvasBoardOwner(path), {
    initialProps: { path: '/one' },
  })
  const oldOwner = repoHook.result.current
  const oldBoard = await refreshBoard(oldOwner)
  const repositoryToken = oldOwner.beginResize(
    oldBoard,
    rectangle,
    'se',
    14,
    mock(),
    mock()
  )
  if (repositoryToken === null)
    throw new Error('repository resize was rejected')
  repoHook.rerender({ path: '/two' })
  expect(repoHook.result.current).not.toBe(oldOwner)
  expect(oldOwner.updateResize(repositoryToken, 14, resized)).toBe(false)
  repoHook.unmount()

  const disposed = start()
  if (disposed === null) throw new Error('dispose resize was rejected')
  owner.dispose()
  owner.activate()
  expect(owner.updateResize(disposed, 9, resized)).toBe(false)
  board = await refreshBoard(owner)
  expect(start()).not.toBeNull()
  expect(write).not.toHaveBeenCalled()
  owner.dispose()
})
