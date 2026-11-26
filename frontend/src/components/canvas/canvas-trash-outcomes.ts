import { ImageService } from '../../../bindings/loom/internal/service'
import {
  type CanvasIntentResult,
  CanvasWriteRejectedError,
} from './canvas-board-owner'

export type CanvasTrashOutcome =
  | { id: number; status: 'fulfilled' }
  | { id: number; status: 'rejected'; error: unknown }

export class CanvasTrashBatchError extends Error {
  readonly outcomes: readonly CanvasTrashOutcome[]

  constructor(outcomes: readonly CanvasTrashOutcome[]) {
    super('One or more trash requests have an unknown outcome.')
    this.name = 'CanvasTrashBatchError'
    this.outcomes = outcomes
  }
}

export type CanvasTrashCompletion =
  | {
      status: 'completed'
      result: CanvasIntentResult<CanvasTrashOutcome[]>
      outcomes: readonly CanvasTrashOutcome[]
    }
  | {
      status: 'failed'
      error: unknown
      outcomes: readonly CanvasTrashOutcome[]
    }

export function captureCanvasTrashCompletion(
  execution: Promise<CanvasIntentResult<CanvasTrashOutcome[]>>,
  getOutcomes: () => readonly CanvasTrashOutcome[] = () => []
): Promise<CanvasTrashCompletion> {
  return execution.then(
    (result) => ({
      status: 'completed',
      result,
      outcomes: result.value ?? [],
    }),
    (error: unknown) => ({
      status: 'failed',
      error,
      outcomes:
        error instanceof CanvasTrashBatchError ? error.outcomes : getOutcomes(),
    })
  )
}

export async function executeCanvasTrashBatch(
  repoPath: string,
  ids: readonly number[],
  trashImage: (
    path: string,
    id: number
  ) => Promise<void> = ImageService.TrashImage,
  onOutcomes?: (outcomes: readonly CanvasTrashOutcome[]) => void
) {
  const results = await Promise.allSettled(
    ids.map((id) => Promise.resolve().then(() => trashImage(repoPath, id)))
  )
  const outcomes = results.map(
    (result, index): CanvasTrashOutcome =>
      result.status === 'fulfilled'
        ? { id: ids[index], status: 'fulfilled' }
        : { id: ids[index], status: 'rejected', error: result.reason }
  )
  onOutcomes?.(outcomes)
  reportCanvasTrashFailures(outcomes)
  if (outcomes.some(isUnknownTrashFailure))
    throw new CanvasTrashBatchError(outcomes)
  return outcomes
}

export function collectCanvasTrashFailures(
  outcomes: readonly CanvasTrashOutcome[]
) {
  return outcomes.filter(
    (outcome): outcome is Extract<CanvasTrashOutcome, { status: 'rejected' }> =>
      outcome.status === 'rejected'
  )
}

export function countCanvasTrashUnknownOutcomes(
  outcomes: readonly CanvasTrashOutcome[]
) {
  return outcomes.filter(isUnknownTrashFailure).length
}

function reportCanvasTrashFailures(outcomes: readonly CanvasTrashOutcome[]) {
  const failures = collectCanvasTrashFailures(outcomes)
  for (const failure of failures)
    console.error('asset trash failed', {
      assetId: failure.id,
      cause: failure.error,
    })
  return failures
}

function isUnknownTrashFailure(outcome: CanvasTrashOutcome) {
  return (
    outcome.status === 'rejected' &&
    !(
      outcome.error instanceof CanvasWriteRejectedError &&
      outcome.error.effectNotApplied
    )
  )
}
