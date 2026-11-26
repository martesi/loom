import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { createCanvasBoardOwner } from './canvas-board-owner'
import {
  captureCanvasSelectionIntent,
  isCanvasSelectionIntentCurrent,
  useCanvasSelectionAuthority,
} from './canvas-selection-intent'

afterEach(() => {
  cleanup()
  mock.restore()
})

it('cancels a queued Ctrl-drag on same-batch A→B→A through the production setter', async () => {
  const repoPath = '/production-selection-authority'
  const owner = createCanvasBoardOwner(repoPath)
  owner.setMode('edit')
  const hook = renderHook(() => useCanvasSelectionAuthority(repoPath), {
    wrapper: StrictMode,
  })
  const captured = captureCanvasSelectionIntent(
    owner,
    hook.result.current.intentRef
  )
  let release = () => {}
  const blocker = owner.execute(
    () => new Promise<void>((resolve) => (release = resolve))
  )
  await Promise.resolve()
  const link = spyOn(ImageService, 'LinkSource').mockResolvedValue(
    undefined as never
  )
  const queued = owner.executeIntent(
    captured.operation,
    () =>
      isCanvasSelectionIntentCurrent(hook.result.current.intentRef, captured),
    () => link(repoPath, 1, 2),
    true
  )
  let updaterCalls = 0
  act(() => {
    hook.result.current.setSelection((current) => {
      updaterCalls++
      return { ...current, ids: [2] }
    })
    hook.result.current.setSelection((current) => {
      updaterCalls++
      return { ...current, ids: [] }
    })
  })
  expect(updaterCalls).toBe(2)
  expect(hook.result.current.intentRef.current.revision).toBe(2)
  expect(hook.result.current.selectionRef.current.ids).toEqual([])
  release()
  await blocker
  expect((await queued).dispatched).toBe(false)
  expect(link).not.toHaveBeenCalled()
  owner.dispose()
})
