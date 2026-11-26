import {
  allowsCanvasCapability,
  type CanvasCapability,
  type CanvasInternalMode,
} from './canvas-mode-policy'

export type CanvasOperationRequest =
  | { kind: 'startup' }
  | { kind: 'recovery' }
  | { kind: 'mode'; target: CanvasInternalMode }
  | {
      kind: 'viewport'
      mode: CanvasInternalMode
      board: object | null
    }
  | {
      kind: 'read'
      capability: CanvasCapability
      board: object | null
    }
  | {
      kind: 'history'
      board: object | null
    }
  | {
      kind: 'mutation'
      capability: CanvasCapability
      board: object | null
    }

export type CanvasUserOperationRequest = Exclude<
  CanvasOperationRequest,
  { kind: 'startup' }
>

export type CanvasOperationOutcome<T> =
  | { status: 'success'; value: T }
  | { status: 'cancelled'; reason: string }
  | { status: 'rejected'; reason: string }
  | { status: 'failed'; error: Error }

const contextBrand: unique symbol = Symbol('CanvasOperationContext')

export interface CanvasOperationContext {
  readonly [contextBrand]: true
  readonly token: object
  assertCurrent(): void
  setMode(mode: CanvasInternalMode): void
  prepare<T>(operation: () => Promise<T>): Promise<T>
  effect<T>(operation: () => Promise<T>): Promise<T>
  reconcile(): Promise<void>
}

export interface CanvasOperationRuntime {
  readonly token: object
  isCurrent(lifetime: number): boolean
  getLifetime(): number
  getMode(): CanvasInternalMode
  getRequestedMode(): CanvasInternalMode | null
  setMode(mode: CanvasInternalMode): void
  getSnapshot(): object | null
  recover(context: CanvasOperationContext): Promise<void>
}

interface Ticket {
  token: object
  lifetime: number
  request: CanvasOperationRequest
  mayFollowQueuedHistory: boolean
  blocksLayout: boolean
  effectStarted: boolean
}

interface RepositoryState {
  tail: Promise<void>
  dirty: boolean
  active: Ticket | null
  queued: Map<object, number>
  layoutPending: number
}

const repositories = new Map<string, RepositoryState>()

function repositoryState(repoPath: string): RepositoryState {
  let repository = repositories.get(repoPath)
  if (!repository) {
    repository = {
      tail: Promise.resolve(),
      dirty: true,
      active: null,
      queued: new Map(),
      layoutPending: 0,
    }
    repositories.set(repoPath, repository)
  }
  return repository
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function isCancelled(
  value: unknown
): value is Error & { canvasCancelled: true } {
  return (
    value instanceof Error && Reflect.get(value, 'canvasCancelled') === true
  )
}

function isRejected(value: unknown): value is Error & { canvasRejected: true } {
  return value instanceof Error && Reflect.get(value, 'canvasRejected') === true
}

export function canvasCancellation(reason: string) {
  const error = new Error(reason)
  Object.assign(error, { canvasCancelled: true })
  return error
}

function canvasRejection(reason: string) {
  const error = new Error(reason)
  Object.assign(error, { canvasRejected: true })
  return error
}

export function isCanvasOperationPending(repoPath: string) {
  const repository = repositories.get(repoPath)
  return Boolean(repository?.layoutPending)
}

export function isCanvasRepositoryDirty(repoPath: string) {
  return repositoryState(repoPath).dirty
}

export function pendingCanvasOperationFor(
  repoPath: string,
  ownerToken: object
) {
  return (repositories.get(repoPath)?.queued.get(ownerToken) ?? 0) > 0
}

export function unwrapCanvasOutcome<T>(outcome: CanvasOperationOutcome<T>): T {
  if (outcome.status === 'success') return outcome.value
  if (outcome.status === 'failed') throw outcome.error
  throw new Error(outcome.reason)
}

export function canvasOutcomeError<T>(
  outcome: CanvasOperationOutcome<T>
): Error | null {
  if (outcome.status === 'failed') return outcome.error
  if (outcome.status === 'rejected') return new Error(outcome.reason)
  return null
}

export function isCanvasOperationOutcome(
  value: unknown
): value is CanvasOperationOutcome<unknown> {
  if (!value || typeof value !== 'object' || !('status' in value)) return false
  return ['success', 'cancelled', 'rejected', 'failed'].includes(
    String(value.status)
  )
}

export function submitCanvasOperation<T>(
  repoPath: string,
  runtime: CanvasOperationRuntime,
  request: CanvasOperationRequest,
  action: (context: CanvasOperationContext) => Promise<T>
): Promise<CanvasOperationOutcome<T>> {
  const repository = repositoryState(repoPath)
  const ticket: Ticket = {
    token: {},
    lifetime: runtime.getLifetime(),
    request,
    mayFollowQueuedHistory:
      request.kind === 'history' &&
      (repository.active?.token === runtime.token ||
        (repository.queued.get(runtime.token) ?? 0) > 0),
    blocksLayout:
      request.kind !== 'read' &&
      request.kind !== 'viewport' &&
      !(request.kind === 'mutation' && request.capability === 'navigate'),
    effectStarted: false,
  }
  if (ticket.blocksLayout) repository.layoutPending++
  repository.queued.set(
    runtime.token,
    (repository.queued.get(runtime.token) ?? 0) + 1
  )
  const previous = repository.tail
  const result = previous.then(
    () => dispatch(repoPath, repository, runtime, ticket, action),
    () => dispatch(repoPath, repository, runtime, ticket, action)
  )
  repository.tail = result.then(
    () => undefined,
    () => undefined
  )
  return result.then((outcome) => {
    decrementQueued(repository, runtime.token, ticket.blocksLayout)
    if (outcome.status === 'success' && !runtime.isCurrent(ticket.lifetime))
      return {
        status: 'cancelled',
        reason: 'The Canvas owner changed before the operation completed.',
      }
    return outcome
  })
}

function dispatch<T>(
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
          ? settle(repository, ticket, {
              status: 'cancelled',
              reason: error.message,
            })
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
      (value) =>
        repository.dirty
          ? recover(
              repository,
              runtime,
              createContext(repoPath, repository, runtime, ticket, true)
            ).then(
              () => settle(repository, ticket, { status: 'success', value }),
              (error: unknown) =>
                isCancelled(error)
                  ? settle(repository, ticket, {
                      status: 'cancelled',
                      reason: error.message,
                    })
                  : settle(repository, ticket, {
                      status: 'failed',
                      error: possibleSuccessError(error),
                    })
            )
          : settle(repository, ticket, { status: 'success', value }),
      (error: unknown) =>
        isCancelled(error)
          ? settle(repository, ticket, {
              status: 'cancelled',
              reason: error.message,
            })
          : isRejected(error) && !repository.dirty
            ? settle(repository, ticket, {
                status: 'rejected',
                reason: error.message,
              })
            : !repository.dirty
              ? settleFailure(repository, ticket, error)
              : recover(
                  repository,
                  runtime,
                  createContext(repoPath, repository, runtime, ticket, true)
                ).then(
                  () => settleFailure(repository, ticket, error),
                  (reconcileError: unknown) =>
                    isCancelled(reconcileError)
                      ? settle(repository, ticket, {
                          status: 'cancelled',
                          reason: reconcileError.message,
                        })
                      : settle(repository, ticket, {
                          status: 'failed',
                          error: possibleSuccessError(reconcileError),
                        })
                )
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
    effect: (operation) => {
      assertCurrent()
      if (
        ticket.request.kind !== 'mutation' &&
        ticket.request.kind !== 'history' &&
        ticket.request.kind !== 'viewport'
      )
        throw new Error('This Canvas operation cannot perform a write.')
      if (affectsBoardState(ticket.request)) repository.dirty = true
      ticket.effectStarted = true
      return operation().then((value) => {
        assertCurrent()
        return value
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
      repository.dirty = false
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

function settle<T>(
  repository: RepositoryState,
  ticket: Ticket,
  outcome: CanvasOperationOutcome<T>
): CanvasOperationOutcome<T> {
  if (repository.active === ticket) repository.active = null
  return outcome
}

function settleFailure<T>(
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

function decrementQueued(
  repository: RepositoryState,
  token: object,
  blocksLayout: boolean
) {
  const count = (repository.queued.get(token) ?? 1) - 1
  if (count) repository.queued.set(token, count)
  else repository.queued.delete(token)
  if (blocksLayout) repository.layoutPending--
}

function possibleSuccessError(error: unknown) {
  return new Error(
    `The operation may have succeeded, but Canvas could not be reconciled: ${errorOf(error).message}`
  )
}

function affectsBoardState(request: CanvasOperationRequest) {
  return !(
    request.kind === 'read' ||
    request.kind === 'viewport' ||
    (request.kind === 'mutation' && request.capability === 'navigate')
  )
}
