import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { ImageService } from '../../../bindings/loom/internal/service'
import { createCanvasBoardOwner } from './canvas-board-owner'
import {
  advanceCanvasSelectionIntent,
  captureCanvasSelectionIntent,
  isCanvasSelectionIntentCurrent,
} from './canvas-selection-intent'

afterEach(() => mock.restore())

it('keeps A→B→A selection intent monotonic', () => {
  const reference = { current: { key: 'A', revision: 0 } }
  const revisions = [
    reference.current.revision,
    advanceCanvasSelectionIntent(reference, 'B').revision,
    advanceCanvasSelectionIntent(reference, 'A').revision,
  ]
  expect(revisions).toEqual([0, 1, 2])
})

it('cancels a queued Ctrl-drag after selection changes away and back', async () => {
  const owner = createCanvasBoardOwner('/ctrl-drag-selection')
  owner.setMode('edit')
  const reference = { current: { key: 'A', revision: 0 } }
  const { revision, operation } = captureCanvasSelectionIntent(owner, reference)
  const link = spyOn(ImageService, 'LinkSource').mockResolvedValue(
    undefined as never
  )
  let release = () => {}
  const blocker = owner.execute(
    () => new Promise<void>((resolve) => (release = resolve))
  )
  await Promise.resolve()
  const pending = owner.executeIntent(
    operation,
    () => isCanvasSelectionIntentCurrent(reference, revision),
    () => link('/ctrl-drag-selection', 1, 2),
    true
  )
  advanceCanvasSelectionIntent(reference, 'B')
  advanceCanvasSelectionIntent(reference, 'A')
  release()
  await blocker
  const result = await pending
  expect(result.dispatched).toBe(false)
  expect(operation.phase).toBe('cancelled')
  expect(link).not.toHaveBeenCalled()
  owner.dispose()
})
