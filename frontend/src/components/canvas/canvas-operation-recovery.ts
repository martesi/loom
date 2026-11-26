import { Call } from '@wailsio/runtime'
import { allowsCanvasCapability } from './canvas-mode-policy'
import type {
  CanvasOperationContext,
  CanvasOperationOutcome,
  CanvasOperationRequest,
  CanvasOperationRuntime,
} from './canvas-operation'
import {
  CanvasOperationUncertainError,
  canvasCancellation,
  canvasRejection,
  contextBrand,
  errorOf,
  isCancelled,
  isRejected,
} from './canvas-operation-errors'

export interface Ticket {
  token: object
  lifetime: number
  intentRevision: number
  request: CanvasOperationRequest
  mayFollowQueuedHistory: boolean
  blocksLayout: boolean
  effectStarted: boolean
  effectAcknowledged: boolean
}

export interface RepositoryState {
  tail: Promise<void>
  dirty: boolean
  uncertain: boolean
  uncertainty: Error | null
  failure: Error | null
  active: Ticket | null
  queued: Map<object, number>
  layoutPending: number
}

export function createCanvasRepositoryState(): RepositoryState {
  return {
    tail: Promise.resolve(),
    dirty: true,
    uncertain: false,
    uncertainty: null,
    failure: null,
    active: null,
    queued: new Map(),
    layoutPending: 0,
  }
}

export function dispatchCanvasOperation<T>(
  repoPath: string,
  repository: RepositoryState,
  runtime: CanvasOperationRuntime,
  ticket: Ticket,
  action: (context: CanvasOperationContext) => Promise<T>
): Promise<CanvasOperationOutcome<T>> {
  if (!runtime.isCurrent(ticket.lifetime))
    return Promise.resolve({
      status: 'cancelled',
      reason: 'The Canvas owner changed before this operation started.',
    })
  if (
    ticket.request.kind !== 'startup' &&
    ticket.request.kind !== 'recovery' &&
    runtime.getIntentRevision() !== ticket.intentRevision
  )
    return Promise.resolve({
      status: 'cancelled',
      reason: 'Canvas operation intent changed before dispatch.',
    })

  if (
    repository.uncertain &&
    ticket.request.kind !== 'startup' &&
    ticket.request.kind !== 'recovery'
  )
    return Promise.resolve({
      status: 'failed',
      error: unknownRepositoryError(repository),
    })

  repository.active = ticket
  const context = createContext(repoPath, repository, runtime, ticket)
  if (
    repository.dirty &&
    ticket.request.kind !== 'startup' &&
    ticket.request.kind !== 'recovery'
  ) {
    return recover(
      repository,
      runtime,
      createContext(repoPath, repository, runtime, ticket, true)
    ).then(
      () =>
        settle(repository, ticket, {
          status: 'rejected',
          reason: 'Canvas was refreshed. Retry the command.',
        }),
      (error: unknown) =>
        isCancelled(error)
          ? settleDispatchError(repository, ticket, error)
          : settle(repository, ticket, {
              status: 'failed',
              error: errorOf(error),
            })
    )
  }

  const rejection = validateRequest(
    runtime,
    ticket.request,
    ticket.mayFollowQueuedHistory
  )
  if (rejection) {
    if (modeRequestCancels(runtime, ticket.request))
      return Promise.resolve(
        settle(repository, ticket, {
          status: 'cancelled',
          reason: 'Canvas is entering View mode.',
        })
      )
    return Promise.resolve(
      settle(repository, ticket, { status: 'rejected', reason: rejection })
    )
  }

  return Promise.resolve()
    .then(() => action(context))
    .then(
      (value) => {
        if (
          ticket.request.kind === 'startup' ||
          ticket.request.kind === 'recovery'
        )
          return settle(repository, ticket, { status: 'success', value })
        if (repository.uncertain)
          return settle(repository, ticket, {
            status: 'failed',
            error: unknownRepositoryError(repository),
          })
        if (!repository.dirty)
          return settle(repository, ticket, { status: 'success', value })
        return Promise.resolve()
          .then(() =>
            recover(
              repository,
              runtime,
              createContext(repoPath, repository, runtime, ticket, true)
            )
          )
          .then(
            () => settle(repository, ticket, { status: 'success', value }),
            (error: unknown) =>
              isCancelled(error)
                ? settleDispatchError(repository, ticket, error)
                : settle(repository, ticket, {
                    status: 'failed',
                    error: possibleSuccessError(error),
                  })
          )
      },
      (error: unknown) => {
        if (isCancelled(error))
          return recoverAfterDispatchedCancellation(
            repoPath,
            repository,
            runtime,
            ticket,
            error
          )
        if (repository.uncertain)
          return settleFailure(
            repository,
            ticket,
            new Error(
              `${errorOf(error).message} ${unknownRepositoryError(repository).message}`
            )
          )
        if (isRejected(error) && !repository.dirty)
          return settle(repository, ticket, {
            status: 'rejected',
            reason: error.message,
          })
        if (!repository.dirty) return settleFailure(repository, ticket, error)
        return Promise.resolve()
          .then(() =>
            recover(
              repository,
              runtime,
              createContext(repoPath, repository, runtime, ticket, true)
            )
          )
          .then(
            () => settleFailure(repository, ticket, error),
            (reconcileError: unknown) =>
              settleFailure(
                repository,
                ticket,
                new Error(
                  `${errorOf(error).message} Canvas reconciliation also failed: ${errorOf(reconcileError).message}`
                )
              )
          )
      }
    )
}

function recoverAfterDispatchedCancellation<T>(
  repoPath: string,
  repository: RepositoryState,
  runtime: CanvasOperationRuntime,
  ticket: Ticket,
  error: Error
): Promise<CanvasOperationOutcome<T>> {
  if (
    !ticket.effectStarted ||
    !ticket.effectAcknowledged ||
    repository.uncertain ||
    !repository.dirty
  )
    return Promise.resolve(settleDispatchError(repository, ticket, error))
  return Promise.resolve()
    .then(() =>
      recover(
        repository,
        runtime,
        createContext(repoPath, repository, runtime, ticket, true)
      )
    )
    .then(
      () =>
        settle(repository, ticket, {
          status: 'cancelled',
          reason: error.message,
        }),
      (reconcileError: unknown) =>
        settle(repository, ticket, {
          status: 'failed',
          error: possibleSuccessError(reconcileError),
        })
    )
}

function createContext(
  repoPath: string,
  repository: RepositoryState,
  runtime: CanvasOperationRuntime,
  ticket: Ticket,
  skipRequestValidation = false
): CanvasOperationContext {
  const assertCurrent = () => {
    if (repository.active !== ticket || !runtime.isCurrent(ticket.lifetime))
      throw canvasCancellation(
        'The Canvas owner changed during this operation.'
      )
    if (!skipRequestValidation && !ticket.effectStarted) {
      if (runtime.getIntentRevision() !== ticket.intentRevision)
        throw canvasCancellation(
          'Canvas operation intent changed before dispatch.'
        )
      if (modeRequestCancels(runtime, ticket.request))
        throw canvasCancellation('Canvas is entering View mode.')
    }
    if (!skipRequestValidation) {
      const rejection = validateRequest(
        runtime,
        ticket.request,
        ticket.mayFollowQueuedHistory,
        ticket.effectStarted
      )
      if (rejection) throw canvasRejection(rejection)
    }
  }
  return {
    [contextBrand]: true,
    token: ticket.token,
    assertCurrent,
    setMode: (mode) => {
      assertCurrent()
      if (ticket.request.kind !== 'mode' || ticket.request.target !== mode)
        throw new Error(
          'Canvas mode can only change inside its matching mode operation.'
        )
      runtime.setMode(mode)
    },
    prepare: (operation) => {
      assertCurrent()
      return operation().then((value) => {
        assertCurrent()
        return value
      })
    },
    effect: <T>(operation: () => Promise<T>) => {
      if (runtime.getIntentRevision() !== ticket.intentRevision)
        throw canvasCancellation(
          'Canvas operation intent changed before dispatch.'
        )
      assertCurrent()
      if (
        ticket.request.kind !== 'mutation' &&
        ticket.request.kind !== 'history' &&
        ticket.request.kind !== 'viewport'
      )
        throw new Error('This Canvas operation cannot perform a write.')
      if (affectsBoardState(ticket.request)) repository.dirty = true
      ticket.effectStarted = true
      if (repository.uncertain) throw unknownRepositoryError(repository)
      return new Promise<T>((resolve, reject) => {
        operation().then((value) => {
          ticket.effectAcknowledged = true
          resolve(value)
        }, reject)
      }).catch((error: unknown) => {
        if (!(error instanceof Call.RuntimeError))
          markRepositoryUncertain(repository, error)
        throw error
      })
    },
    reconcile: () =>
      recover(
        repository,
        runtime,
        createContext(repoPath, repository, runtime, ticket, true)
      ),
  }
}

function recover(
  repository: RepositoryState,
  runtime: CanvasOperationRuntime,
  context: CanvasOperationContext
): Promise<void> {
  context.assertCurrent()
  return Promise.resolve()
    .then(() => runtime.recover(context))
    .then(() => {
      context.assertCurrent()
      if (!repository.uncertain) {
        repository.dirty = false
        repository.failure = null
      }
    })
    .catch((error: unknown) => {
      repository.dirty = true
      repository.failure = errorOf(error)
      throw error
    })
}

function validateRequest(
  runtime: CanvasOperationRuntime,
  request: CanvasOperationRequest,
  mayFollowQueuedHistory = false,
  dispatchedEffect = false
): string | null {
  if (
    request.kind === 'mode' ||
    request.kind === 'startup' ||
    request.kind === 'recovery'
  )
    return null
  if (request.kind === 'history') {
    if (
      request.board !== runtime.getSnapshot() &&
      !(mayFollowQueuedHistory && runtime.getSnapshot() !== null)
    )
      return 'Canvas changed. Retry the history command.'
    return null
  }
  if (request.kind === 'viewport') {
    if (request.board !== runtime.getSnapshot())
      return 'Canvas changed. Retry the viewport update.'
    if (
      runtime.getMode() !== request.mode ||
      (!dispatchedEffect && runtime.getRequestedMode() !== null)
    )
      return 'Canvas mode changed before the viewport update.'
    return null
  }
  if (
    request.kind === 'mutation' &&
    !dispatchedEffect &&
    runtime.getRequestedMode() === 'view' &&
    (request.capability === 'geometry' ||
      request.capability === 'relationship' ||
      request.capability === 'canvas-drop')
  )
    return 'This operation is not available in the current Canvas mode.'
  if (request.board !== runtime.getSnapshot())
    return 'Canvas changed. Retry the command.'
  if (!allowsCanvasCapability(runtime.getMode(), request.capability))
    return 'This operation is not available in the current Canvas mode.'
  return null
}

function modeRequestCancels(
  runtime: CanvasOperationRuntime,
  request: CanvasOperationRequest
) {
  return (
    (request.kind === 'viewport' &&
      (runtime.getRequestedMode() !== null ||
        runtime.getMode() !== request.mode)) ||
    (request.kind === 'mutation' &&
      runtime.getRequestedMode() === 'view' &&
      (request.capability === 'geometry' ||
        request.capability === 'relationship' ||
        request.capability === 'canvas-drop'))
  )
}

export function settle<T>(
  repository: RepositoryState,
  ticket: Ticket,
  outcome: CanvasOperationOutcome<T>
): CanvasOperationOutcome<T> {
  if (repository.active === ticket) repository.active = null
  return outcome
}

export function settleFailure<T>(
  repository: RepositoryState,
  ticket: Ticket,
  error: unknown
): CanvasOperationOutcome<T> {
  if (isCancelled(error))
    return settle(repository, ticket, {
      status: 'cancelled',
      reason: error.message,
    })
  if (isRejected(error))
    return settle(repository, ticket, {
      status: 'rejected',
      reason: error.message,
    })
  return settle(repository, ticket, { status: 'failed', error: errorOf(error) })
}

export function settleDispatchError<T>(
  repository: RepositoryState,
  ticket: Ticket,
  error: unknown
): CanvasOperationOutcome<T> {
  if (isCancelled(error) && ticket.effectStarted && repository.dirty) {
    if (!ticket.effectAcknowledged) markRepositoryUncertain(repository, error)
    if (repository.uncertain)
      return settle(repository, ticket, {
        status: 'failed',
        error: unknownRepositoryError(repository),
      })
    return settle(repository, ticket, {
      status: 'failed',
      error: possibleSuccessError(error),
    })
  }
  if (ticket.effectStarted && repository.dirty && !repository.uncertain)
    markRepositoryUncertain(repository, error)
  return settleFailure(repository, ticket, error)
}

function possibleSuccessError(error: unknown) {
  return new Error(
    `The operation may have succeeded, but Canvas could not be reconciled: ${errorOf(error).message}`
  )
}

function markRepositoryUncertain(repository: RepositoryState, error: unknown) {
  repository.uncertain = true
  repository.dirty = true
  repository.uncertainty ??= new CanvasOperationUncertainError(error)
}

function unknownRepositoryError(repository: RepositoryState) {
  return (
    repository.uncertainty ??
    new CanvasOperationUncertainError(
      new Error(
        'Repository state is unknown because a write may still commit. Further writes are blocked. Refreshing or reopening this repository cannot prove settlement; do not retry the operation. Verify the repository outside this app or contact support.'
      )
    )
  )
}

function affectsBoardState(request: CanvasOperationRequest) {
  return !(
    request.kind === 'read' ||
    request.kind === 'viewport' ||
    (request.kind === 'mutation' && request.capability === 'navigate')
  )
}
