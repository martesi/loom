import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import {
  CanvasWriteRejectedError,
  createCanvasBoardOwner,
  createCanvasRepositoryQueue,
} from './canvas-board-owner'
import {
  CanvasTrashBatchError,
  captureCanvasTrashCompletion,
  collectCanvasTrashFailures,
  countCanvasTrashUnknownOutcomes,
  executeCanvasTrashBatch,
} from './canvas-trash-outcomes'

afterEach(() => mock.restore())

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

function readyRefresh(owner: ReturnType<typeof createCanvasBoardOwner>) {
  return spyOn(owner, 'refresh').mockResolvedValue({
    snapshot: { revision: 'read-after-write', images: [], relationships: [] },
    data: { images: [], relationships: [] } as never,
  } as never)
}

it('keeps each trash child outcome and original error while fencing unknown results', async () => {
  const owner = createCanvasBoardOwner('/trash-mixed')
  owner.setMode('edit')
  const refresh = readyRefresh(owner)
  const settled = new CanvasWriteRejectedError('confirmed validation rejection')
  const unknown = new TypeError('connection lost after dispatch')
  const logged = spyOn(console, 'error').mockImplementation(() => {})
  const intent = owner.captureIntent('lifecycle', 0)
  const completion = await captureCanvasTrashCompletion(
    owner.executeIntent(
      intent,
      () => true,
      () =>
        executeCanvasTrashBatch('/trash-mixed', [11, 12, 13], (_path, id) => {
          if (id === 12) return Promise.reject(settled)
          if (id === 13) return Promise.reject(unknown)
          return Promise.resolve()
        }),
      true
    )
  )

  expect(completion.status).toBe('failed')
  if (completion.status !== 'failed') return
  expect(completion.error).toBeInstanceOf(CanvasTrashBatchError)
  const batch = completion.error as CanvasTrashBatchError
  expect(batch.outcomes).toEqual([
    { id: 11, status: 'fulfilled' },
    { id: 12, status: 'rejected', error: settled },
    { id: 13, status: 'rejected', error: unknown },
  ])
  expect(
    batch.outcomes[1]?.status === 'rejected' && batch.outcomes[1].error
  ).toBe(settled)
  expect(
    batch.outcomes[2]?.status === 'rejected' && batch.outcomes[2].error
  ).toBe(unknown)
  expect(owner.getMutationFence()).toMatchObject({
    uncertain: true,
    effect: 'unknown',
    error: batch,
  })
  expect(intent.phase).toBe('unknown')
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(logged).toHaveBeenCalledWith('asset trash failed', {
    assetId: 12,
    cause: settled,
  })
  expect(logged).toHaveBeenCalledWith('asset trash failed', {
    assetId: 13,
    cause: unknown,
  })
  expect(collectCanvasTrashFailures(batch.outcomes)).toHaveLength(2)
  expect(countCanvasTrashUnknownOutcomes(batch.outcomes)).toBe(1)
  owner.dispose()
})

it('reconciles success plus a confirmed child rejection without an unknown fence', async () => {
  const owner = createCanvasBoardOwner('/trash-settled-rejection')
  owner.setMode('edit')
  const refresh = readyRefresh(owner)
  const failure = new CanvasWriteRejectedError('child was not applied')
  const intent = owner.captureIntent('lifecycle', 0)
  const completion = await captureCanvasTrashCompletion(
    owner.executeIntent(
      intent,
      () => true,
      () =>
        executeCanvasTrashBatch(
          '/trash-settled-rejection',
          [14, 15],
          (_path, id) =>
            id === 15 ? Promise.reject(failure) : Promise.resolve()
        ),
      true
    )
  )

  expect(completion.status).toBe('completed')
  expect(completion.outcomes).toEqual([
    { id: 14, status: 'fulfilled' },
    { id: 15, status: 'rejected', error: failure },
  ])
  expect(owner.getMutationFence()).toBeNull()
  expect(intent.phase).toBe('reconciled')
  expect(refresh).toHaveBeenCalledTimes(1)
  owner.dispose()
})

it('waits for every delayed child before returning or raising an unknown result', async () => {
  const delayed = deferred<void>()
  const knownFailure = new CanvasWriteRejectedError('settled rejection')
  let finished = false
  const batch = executeCanvasTrashBatch('/trash-held', [21, 22], (_path, id) =>
    id === 21 ? Promise.reject(knownFailure) : delayed.promise
  ).then(
    (outcomes) => {
      finished = true
      return outcomes
    },
    (error: unknown) => {
      finished = true
      throw error
    }
  )

  await Promise.resolve()
  expect(finished).toBe(false)
  delayed.reject(new TypeError('late child transport failure'))
  const completion = await batch.then(
    (outcomes) => ({ status: 'completed' as const, outcomes }),
    (error: unknown) => ({ status: 'failed' as const, error })
  )
  expect(completion.status).toBe('failed')
  if (completion.status !== 'failed') return
  expect(completion.error).toBeInstanceOf(CanvasTrashBatchError)
  expect((completion.error as CanvasTrashBatchError).outcomes).toHaveLength(2)
})

it('reports dispatched child failures after owner replacement and selection churn', async () => {
  const lane = createCanvasRepositoryQueue()
  const owner = createCanvasBoardOwner('/trash-replaced', lane)
  owner.setMode('edit')
  const replacement = createCanvasBoardOwner('/trash-replaced', lane)
  const refreshGate =
    deferred<Awaited<ReturnType<typeof replacement.refresh>>>()
  const refreshStarted = deferred<void>()
  const refresh = spyOn(replacement, 'refresh').mockImplementation(() => {
    refreshStarted.resolve()
    return refreshGate.promise
  })
  const delayed = deferred<void>()
  const started = deferred<void>()
  const diagnosed = deferred<void>()
  const failure = new TypeError('child response was lost')
  const intent = owner.captureIntent('lifecycle', 0)
  let selectionCurrent = true
  let executionSettled = false
  const logged = spyOn(console, 'error').mockImplementation((event) => {
    if (event === 'asset trash failed') diagnosed.resolve()
  })
  const completion = captureCanvasTrashCompletion(
    owner.executeIntent(
      intent,
      () => selectionCurrent,
      () =>
        executeCanvasTrashBatch('/trash-replaced', [31], () => {
          started.resolve()
          return delayed.promise
        }),
      true
    )
  ).then((result) => {
    executionSettled = true
    return result
  })

  await started.promise
  owner.dispose()
  selectionCurrent = false
  delayed.reject(failure)
  expect(selectionCurrent).toBe(false)
  await diagnosed.promise
  await refreshStarted.promise
  expect(executionSettled).toBe(false)
  expect(logged).toHaveBeenCalledWith('asset trash failed', {
    assetId: 31,
    cause: failure,
  })
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(replacement.getMutationFence()).toMatchObject({
    uncertain: true,
    effect: 'unknown',
  })
  refreshGate.resolve({
    snapshot: { revision: 'replacement-read', images: [], relationships: [] },
    data: { images: [], relationships: [] } as never,
  } as never)
  const settled = await completion
  expect(settled.status).toBe('failed')
  if (settled.status !== 'failed') return
  expect(settled.error).toBeInstanceOf(CanvasTrashBatchError)
  const outcomes = settled.outcomes
  const failures = collectCanvasTrashFailures(outcomes)
  expect(failures).toEqual([{ id: 31, status: 'rejected', error: failure }])
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(replacement.getMutationFence()).toMatchObject({
    uncertain: true,
    effect: 'unknown',
  })
  replacement.dispose()
})
