import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { Toast } from '@base-ui-components/react/toast'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import {
  ImageService,
  UndoService,
} from '../../../bindings/loom/internal/service'
import { createCanvasBoardOwner } from './canvas-board-owner'
import { refreshBoard } from './canvas-operation-test-utils'

mock.module('@lingui/core/macro', () => ({
  t: (parts: TemplateStringsArray) => parts.join(''),
  plural: (count: number, messages: { one: string; other: string }) =>
    count === 1 ? messages.one : messages.other,
}))
const { useUndoActions } = await import('../../lib/use-undo')
const rectangle = { imageId: 1, x: 10, y: 20, w: 150, h: 110 }
const wrapper = ({ children }: { children: React.ReactNode }) =>
  createElement(Toast.Provider, null, children)

function setup() {
  spyOn(ImageService, 'LoadCanvas').mockImplementation(
    () => Promise.resolve({ images: [{ id: 1 }], groups: [] }) as never
  )
  spyOn(ImageService, 'GetLayoutSnapshot').mockImplementation(
    () =>
      Promise.resolve({
        revision: '1',
        images: [{ id: 1, width: 640, height: 480, geometry: rectangle }],
        relationships: [],
      }) as never
  )
  const undo = spyOn(UndoService, 'Undo').mockImplementation(
    () => Promise.resolve({ applied: false, error: '' }) as never
  )
  return { undo, owner: createCanvasBoardOwner('/repo') }
}
afterEach(() => {
  cleanup()
  mock.restore()
})

it('cancels an unfinished drag before undo and rejects its late stop', async () => {
  const { owner, undo } = setup()
  const write = spyOn(
    ImageService,
    'SetGeometryFromDisplayAtRevision'
  ).mockImplementation(() => Promise.resolve() as never)
  const board = await refreshBoard(owner)
  const gesture = owner.beginDrag(board, [rectangle])
  if (!gesture) throw new Error('missing drag')
  const { result } = renderHook(() => useUndoActions('/repo', owner), {
    wrapper,
  })
  await act(async () => {
    await result.current.undo()
    await owner.endDrag(gesture, [{ ...rectangle, x: 50 }])
  })
  expect(undo).toHaveBeenCalledTimes(1)
  expect(write).not.toHaveBeenCalled()
})

it('runs undo only after a completed drag write and refresh', async () => {
  const { owner, undo } = setup()
  let release = () => {}
  const write = spyOn(
    ImageService,
    'SetGeometryFromDisplayAtRevision'
  ).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }) as never
  )
  const board = await refreshBoard(owner)
  const gesture = owner.beginDrag(board, [rectangle])
  if (!gesture) throw new Error('missing drag')
  const pending = owner.endDrag(gesture, [{ ...rectangle, x: 50 }])
  const { result } = renderHook(() => useUndoActions('/repo', owner), {
    wrapper,
  })
  const undone = result.current.undo()
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
  expect(undo).not.toHaveBeenCalled()
  await act(async () => {
    release()
    await pending
    await undone
  })
  expect(ImageService.LoadCanvas).toHaveBeenCalledTimes(3)
  expect(undo).toHaveBeenCalledTimes(1)
})
