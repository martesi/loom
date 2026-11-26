import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { Call } from '@wailsio/runtime'
import {
  ImageService,
  UndoService,
} from '../../../bindings/loom/internal/service'
import type { CanvasInternalMode } from './canvas-mode-policy'
import {
  type CanvasOperationContext,
  type CanvasOperationRuntime,
  canvasRepositoryIssue,
  isCanvasOperationPending,
  isCanvasRepositoryDirty,
  isCanvasRepositoryUncertain,
  submitCanvasOperation,
} from './canvas-operation'
import { canvasEffects } from './canvas-operation-effects'

afterEach(() => mock.restore())

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function runtime(repo: string) {
  const token = {}
  let lifetime = 0
  let intentRevision = 0
  let mode: CanvasInternalMode = 'edit'
  let requestedMode: CanvasInternalMode | null = null
  let snapshot: object | null = {}
  let reconciliations = 0
  const state = () => ({ lifetime, mode, snapshot, reconciliations })
  const value: CanvasOperationRuntime = {
    token,
    isCurrent: (revision) => revision === lifetime,
    getLifetime: () => lifetime,
    getIntentRevision: () => intentRevision,
    getMode: () => mode,
    getRequestedMode: () => requestedMode,
    setMode: (next) => {
      mode = next
      requestedMode = null
    },
    getSnapshot: () => snapshot,
    recover: async (context) => {
      context.assertCurrent()
      reconciliations++
    },
  }
  return {
    runtime: value,
    state,
    replaceSnapshot: () => {
      snapshot = {}
    },
    setMode: (next: CanvasInternalMode) => {
      mode = next
    },
    requestMode: (next: CanvasInternalMode) => {
      requestedMode = next
    },
    replaceLifetime: () => {
      lifetime++
    },
    advanceIntent: () => {
      intentRevision++
    },
    repo,
  }
}

const mutation = (
  board: object | null,
  capability: 'geometry' | 'relationship' = 'geometry'
) => ({
  kind: 'mutation' as const,
  capability,
  board,
})

async function start(owner: ReturnType<typeof runtime>) {
  return submitCanvasOperation(
    owner.repo,
    owner.runtime,
    { kind: 'startup' },
    (context) => context.reconcile()
  )
}

it('keeps mode transitions and writes in one FIFO', async () => {
  const owner = runtime('/canvas-op-mode-fifo')
  await start(owner)
  const board = owner.runtime.getSnapshot()
  const unlink = spyOn(ImageService, 'UnlinkSource').mockResolvedValue(
    undefined as never
  )
  const blocker = deferred<void>()
  const blockingStarted = deferred<void>()
  const preceding = submitCanvasOperation(
    owner.repo,
    owner.runtime,
    { kind: 'read', capability: 'select', board },
    async () => {
      blockingStarted.resolve()
      await blocker.promise
    }
  )
  await blockingStarted.promise
  const write = submitCanvasOperation(
    owner.repo,
    owner.runtime,
    mutation(board, 'relationship'),
    (context) => canvasEffects.unlinkSource(context, '/repo', 7)
  )
  owner.requestMode('view')
  const view = submitCanvasOperation(
    owner.repo,
    owner.runtime,
    { kind: 'mode', target: 'view' },
    async (context) => context.setMode('view')
  )

  blocker.resolve()
  expect((await preceding).status).toBe('success')
  expect((await view).status).toBe('success')
  expect(await write).toMatchObject({ status: 'cancelled' })
  expect(unlink).not.toHaveBeenCalled()
  expect(owner.state().mode).toBe('view')
})

it('lets an already dispatched effect settle and reconcile before View', async () => {
  const owner = runtime('/canvas-op-dispatched-before-view')
  await start(owner)
  const board = owner.runtime.getSnapshot()
  const effect = deferred<void>()
  const started = deferred<void>()
  const write = submitCanvasOperation(
    owner.repo,
    owner.runtime,
    mutation(board),
    (context) =>
      context.effect(async () => {
        started.resolve()
        await effect.promise
      })
  )
  await started.promise
  owner.requestMode('view')
  const view = submitCanvasOperation(
    owner.repo,
    owner.runtime,
    { kind: 'mode', target: 'view' },
    async (context) => context.setMode('view')
  )

  effect.resolve()
  expect((await write).status).toBe('success')
  expect((await view).status).toBe('success')
  expect(owner.state()).toMatchObject({ mode: 'view', reconciliations: 2 })
})

it('replays history queued behind a write against that write’s accepted snapshot', async () => {
  const owner = runtime('/canvas-op-history-after-write')
  await start(owner)
  const board = owner.runtime.getSnapshot()
  const release = deferred<void>()
  const started = deferred<void>()
  const recover = owner.runtime.recover
  owner.runtime.recover = async (context) => {
    await recover(context)
    owner.replaceSnapshot()
  }
  const write = submitCanvasOperation(
    owner.repo,
    owner.runtime,
    mutation(board),
    async (context) =>
      context.effect(async () => {
        started.resolve()
        await release.promise
      })
  )
  await started.promise
  const history = submitCanvasOperation(
    owner.repo,
    owner.runtime,
    { kind: 'history', board },
    async (context) => context.effect(async () => ({ applied: true }))
  )

  release.resolve()
  expect((await write).status).toBe('success')
  expect(await history).toMatchObject({ status: 'success' })
})

it('settles synchronous failures and keeps the repository queue usable', async () => {
  const owner = runtime('/canvas-op-sync-failure')
  await start(owner)
  const board = owner.runtime.getSnapshot()
  const failed = await submitCanvasOperation(
    owner.repo,
    owner.runtime,
    mutation(board),
    () => {
      throw new Error('sync failure')
    }
  )
  expect(failed).toMatchObject({ status: 'failed' })
  const next = await submitCanvasOperation(
    owner.repo,
    owner.runtime,
    mutation(board),
    async () => 'queue remains usable'
  )
  expect(next).toMatchObject({
    status: 'success',
    value: 'queue remains usable',
  })
})

it('does not block geometry gestures for a queued board read', async () => {
  const owner = runtime('/canvas-op-read')
  await start(owner)
  const board = owner.runtime.getSnapshot()
  const release = deferred<void>()
  const started = deferred<void>()
  const read = submitCanvasOperation(
    owner.repo,
    owner.runtime,
    { kind: 'read', capability: 'metadata', board },
    async (context) =>
      context.prepare(async () => {
        started.resolve()
        await release.promise
      })
  )
  await started.promise
  expect(isCanvasOperationPending(owner.repo)).toBe(false)
  release.resolve()
  expect((await read).status).toBe('success')
})

it('serializes viewport writes without marking the board dirty or blocking layout', async () => {
  const owner = runtime('/canvas-op-viewport')
  await start(owner)
  const board = owner.runtime.getSnapshot()
  const outcome = await submitCanvasOperation(
    owner.repo,
    owner.runtime,
    { kind: 'mutation', capability: 'navigate', board },
    async (context) => {
      expect(isCanvasOperationPending(owner.repo)).toBe(false)
      return context.effect(async () => 'viewport saved')
    }
  )

  expect(outcome).toMatchObject({ status: 'success', value: 'viewport saved' })
  expect(owner.state().reconciliations).toBe(1)
})

it('fences repository after an unacknowledged effect failure', async () => {
  const owner = runtime('/canvas-op-partial-effect')
  await start(owner)
  const board = owner.runtime.getSnapshot()
  let partialWrite = false
  let effectContext!: CanvasOperationContext
  const failed = await submitCanvasOperation(
    owner.repo,
    owner.runtime,
    mutation(board),
    async (context) => {
      effectContext = context
      await context.effect(async () => {
        partialWrite = true
        throw new Error('backend failed after partial write')
      })
    }
  )
  expect(partialWrite).toBe(true)
  expect(failed.status).toBe('failed')
  expect(owner.state().reconciliations).toBe(1)

  const next = await submitCanvasOperation(
    owner.repo,
    owner.runtime,
    mutation(board),
    async (context) => context.effect(async () => 'written')
  )
  expect(next.status).toBe('failed')
  expect(effectContext.token).not.toBeNull()
  expect(owner.state().reconciliations).toBe(1)
})

it('recovers after a settled Wails backend error and allows the next mutation', async () => {
  const owner = runtime('/canvas-op-settled-backend-error')
  await start(owner)
  const board = owner.runtime.getSnapshot()
  const backendError = new Call.RuntimeError('stale layout revision')
  const rejected = await submitCanvasOperation(
    owner.repo,
    owner.runtime,
    mutation(board),
    (context) => context.effect(async () => Promise.reject(backendError))
  )
  expect(rejected).toMatchObject({ status: 'failed', error: backendError })
  expect(isCanvasRepositoryDirty(owner.repo)).toBe(false)
  expect(isCanvasRepositoryUncertain(owner.repo)).toBe(false)

  const next = await submitCanvasOperation(
    owner.repo,
    owner.runtime,
    mutation(board),
    (context) => context.effect(async () => 'next write')
  )
  expect(next).toMatchObject({ status: 'success', value: 'next write' })
})

it('keeps the repository dirty when history reconciliation fails', async () => {
  const owner = runtime('/canvas-op-history-recovery')
  await start(owner)
  const recover = owner.runtime.recover
  let failRecovery = true
  owner.runtime.recover = async (context) => {
    if (failRecovery) throw new Error('reload failed')
    await recover(context)
  }
  const board = owner.runtime.getSnapshot()
  const history = await submitCanvasOperation(
    owner.repo,
    owner.runtime,
    { kind: 'history', board },
    async (context) => context.effect(async () => ({ applied: true }))
  )
  expect(history.status).toBe('failed')

  failRecovery = false
  const ordinary = await submitCanvasOperation(
    owner.repo,
    owner.runtime,
    mutation(board),
    async () => 'must wait for recovery'
  )
  expect(ordinary).toMatchObject({ status: 'rejected' })
  expect(owner.state().reconciliations).toBe(2)
})

it('cancels prepared work after owner replacement and permits fresh activation', async () => {
  const owner = runtime('/canvas-op-lifetime')
  await start(owner)
  const board = owner.runtime.getSnapshot()
  const preparation = deferred<void>()
  let wrote = false
  const stale = submitCanvasOperation(
    owner.repo,
    owner.runtime,
    mutation(board),
    async (context) => {
      await context.prepare(() => preparation.promise)
      await context.effect(async () => {
        wrote = true
      })
    }
  )
  await Promise.resolve()
  owner.replaceLifetime()
  preparation.resolve()
  expect(await stale).toMatchObject({ status: 'cancelled' })
  expect(wrote).toBe(false)

  const fresh = runtime(owner.repo)
  const outcome = await submitCanvasOperation(
    fresh.repo,
    fresh.runtime,
    { kind: 'recovery' },
    async (context) => context.reconcile()
  )
  expect(outcome.status).toBe('success')
})

it('retains dirty state after disposal and recovers an acknowledged write with a replacement owner', async () => {
  const owner = runtime('/canvas-op-disposed-effect')
  await start(owner)
  const board = owner.runtime.getSnapshot()
  const write = deferred<void>()
  const started = deferred<void>()
  const pending = submitCanvasOperation(
    owner.repo,
    owner.runtime,
    mutation(board),
    (context) =>
      context.effect(() => {
        started.resolve()
        return write.promise
      })
  )
  await started.promise
  owner.replaceLifetime()
  write.resolve()

  expect(await pending).toMatchObject({ status: 'failed' })
  expect(isCanvasOperationPending(owner.repo)).toBe(false)
  expect(isCanvasRepositoryDirty(owner.repo)).toBe(true)
  expect(isCanvasRepositoryUncertain(owner.repo)).toBe(false)

  const reactivated = await submitCanvasOperation(
    owner.repo,
    owner.runtime,
    { kind: 'recovery' },
    (context) => context.reconcile()
  )
  expect(reactivated.status).toBe('success')
  expect(isCanvasRepositoryDirty(owner.repo)).toBe(false)
  expect(isCanvasOperationPending(owner.repo)).toBe(false)

  const replacement = runtime(owner.repo)
  expect((await start(replacement)).status).toBe('success')
  const replacementBoard = replacement.runtime.getSnapshot()
  const freshMutation = await submitCanvasOperation(
    replacement.repo,
    replacement.runtime,
    mutation(replacementBoard),
    (context) => context.effect(async () => 'fresh write')
  )
  expect(freshMutation).toMatchObject({
    status: 'success',
    value: 'fresh write',
  })
  expect(isCanvasOperationPending(owner.repo)).toBe(false)
})

it('does not treat repeated recovery reads as settlement proof after a lost response', async () => {
  const owner = runtime('/canvas-op-late-commit')
  await start(owner)
  const board = owner.runtime.getSnapshot()
  const lateCommit = deferred<void>()
  let committedLate = false
  let mutationCalls = 0
  const lostResponse = await submitCanvasOperation(
    owner.repo,
    owner.runtime,
    mutation(board),
    (context) =>
      context.effect(async () => {
        mutationCalls++
        void lateCommit.promise.then(() => {
          committedLate = true
        })
        throw new Error('transport response lost before commit acknowledgment')
      })
  )
  expect(lostResponse).toMatchObject({ status: 'failed' })
  expect(isCanvasRepositoryDirty(owner.repo)).toBe(true)
  expect(isCanvasRepositoryUncertain(owner.repo)).toBe(true)
  expect(canvasRepositoryIssue(owner.repo)?.message).toContain('unknown')

  for (let index = 0; index < 2; index++) {
    const refresh = await submitCanvasOperation(
      owner.repo,
      owner.runtime,
      { kind: 'recovery' },
      (context) => context.reconcile()
    )
    expect(refresh.status).toBe('success')
    expect(isCanvasRepositoryDirty(owner.repo)).toBe(true)
    expect(isCanvasRepositoryUncertain(owner.repo)).toBe(true)
  }
  lateCommit.resolve()
  await lateCommit.promise
  expect(committedLate).toBe(true)

  const replacement = runtime(owner.repo)
  expect((await start(replacement)).status).toBe('success')
  const blocked = await submitCanvasOperation(
    replacement.repo,
    replacement.runtime,
    mutation(replacement.runtime.getSnapshot()),
    async (context) => {
      mutationCalls++
      await context.effect(async () => 'must remain fenced')
    }
  )
  expect(blocked).toMatchObject({ status: 'failed' })
  expect(mutationCalls).toBe(1)
  expect(isCanvasRepositoryDirty(owner.repo)).toBe(true)
})

it('holds replacement activation behind an Undo whose response is lost', async () => {
  const owner = runtime('/canvas-op-held-undo-replacement')
  await start(owner)
  const board = owner.runtime.getSnapshot()
  const undoResponse = deferred<never>()
  const undoStarted = deferred<void>()
  spyOn(UndoService, 'Undo').mockImplementation(() => {
    undoStarted.resolve()
    return undoResponse.promise
  })
  const undo = submitCanvasOperation(
    owner.repo,
    owner.runtime,
    { kind: 'history', board },
    (context) => canvasEffects.undo(context, owner.repo)
  )
  await undoStarted.promise
  owner.replaceLifetime()
  const replacement = runtime(owner.repo)
  const activation = start(replacement)
  await Promise.resolve()
  expect(replacement.state().reconciliations).toBe(0)
  undoResponse.reject(new Error('Undo response lost'))
  expect(await undo).toMatchObject({ status: 'failed' })
  expect((await activation).status).toBe('success')
  expect(isCanvasRepositoryDirty(owner.repo)).toBe(true)

  let mutationCalled = false
  const blocked = await submitCanvasOperation(
    replacement.repo,
    replacement.runtime,
    mutation(replacement.runtime.getSnapshot()),
    async () => {
      mutationCalled = true
    }
  )
  expect(blocked.status).toBe('failed')
  expect(mutationCalled).toBe(false)
})

it('rejects a stale board after async preparation before performing its effect', async () => {
  const owner = runtime('/canvas-op-stale-board')
  await start(owner)
  const board = owner.runtime.getSnapshot()
  const preparation = deferred<void>()
  const started = deferred<void>()
  let wrote = false
  const operation = submitCanvasOperation(
    owner.repo,
    owner.runtime,
    mutation(board),
    async (context) => {
      await context.prepare(async () => {
        started.resolve()
        await preparation.promise
      })
      await context.effect(async () => {
        wrote = true
      })
    }
  )
  await started.promise
  owner.replaceSnapshot()
  preparation.resolve()

  expect(await operation).toMatchObject({ status: 'rejected' })
  expect(wrote).toBe(false)
})
