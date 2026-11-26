import type { CanvasCapability, CanvasInternalMode } from './canvas-mode-policy'
import { contextBrand } from './canvas-operation-errors'
import {
  createCanvasRepositoryState,
  dispatchCanvasOperation,
  type RepositoryState,
  settleDispatchError,
  settleFailure,
  type Ticket,
} from './canvas-operation-recovery'

export {
  CanvasOperationUncertainError,
  canvasCancellation,
  isCanvasOperationCancellation,
  isCanvasOperationUncertainError,
} from './canvas-operation-errors'

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

export interface CanvasUserIntent {
  owner: object
  repoPath: string
  lifetimeRevision: number
  modeRevision: number
  mode: CanvasInternalMode
  selectionSurface: 'assets' | 'canvas'
  ownerIntentRevision: number
  selectionRevision: number
  board: object | null
}

export type CanvasOperationOutcome<T> =
  | { status: 'success'; value: T }
  | { status: 'cancelled'; reason: string }
  | { status: 'rejected'; reason: string }
  | { status: 'failed'; error: Error }

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
  getIntentRevision(): number
  getMode(): CanvasInternalMode
  getRequestedMode(): CanvasInternalMode | null
  setMode(mode: CanvasInternalMode): void
  getSnapshot(): object | null
  recover(context: CanvasOperationContext): Promise<void>
}

const repositories = new Map<string, RepositoryState>()

function repositoryState(repoPath: string): RepositoryState {
  let repository = repositories.get(repoPath)
  if (!repository) {
    repository = createCanvasRepositoryState()
    repositories.set(repoPath, repository)
  }
  return repository
}

export function isCanvasOperationPending(repoPath: string) {
  const repository = repositories.get(repoPath)
  return Boolean(repository?.layoutPending)
}

export function isCanvasRepositoryDirty(repoPath: string) {
  const repository = repositoryState(repoPath)
  return repository.dirty || repository.uncertain
}

export function canvasRepositoryUncertainty(repoPath: string) {
  return repositories.get(repoPath)?.uncertainty ?? null
}

export function isCanvasRepositoryUncertain(repoPath: string) {
  return repositories.get(repoPath)?.uncertain ?? false
}

export function canvasRepositoryIssue(repoPath: string) {
  const repository = repositories.get(repoPath)
  return repository?.uncertainty ?? repository?.failure ?? null
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
    intentRevision: runtime.getIntentRevision(),
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
    effectAcknowledged: false,
  }
  if (ticket.blocksLayout) repository.layoutPending++
  repository.queued.set(
    runtime.token,
    (repository.queued.get(runtime.token) ?? 0) + 1
  )
  const previous = repository.tail
  const dispatchResult: Promise<CanvasOperationOutcome<T>> = previous.then(() =>
    Promise.resolve().then(() =>
      dispatchCanvasOperation<T>(repoPath, repository, runtime, ticket, action)
    )
  )
  const result = dispatchResult
    .then(
      (outcome) => outcome,
      (error: unknown) => settleDispatchError<T>(repository, ticket, error)
    )
    .catch((error: unknown) => settleFailure<T>(repository, ticket, error))
  const finalized = result
    .then((outcome) => {
      if (repository.active === ticket) repository.active = null
      if (outcome.status === 'success' && !runtime.isCurrent(ticket.lifetime))
        return {
          status: 'cancelled' as const,
          reason: 'The Canvas owner changed before the operation completed.',
        }
      return outcome
    })
    .finally(() => {
      if (repository.active === ticket) repository.active = null
      decrementQueued(repository, runtime.token, ticket.blocksLayout)
    })
  repository.tail = finalized.then(
    () => undefined,
    () => undefined
  )
  return finalized
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
