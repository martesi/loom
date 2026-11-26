export const contextBrand: unique symbol = Symbol('CanvasOperationContext')

export class CanvasOperationUncertainError extends Error {
  constructor(readonly cause: unknown) {
    const message = errorOf(cause).message
    super(
      `Repository state is unknown because a write may have committed: ${message}. Further writes are blocked. Refreshing or reopening this repository cannot prove settlement; do not retry the operation. Verify the repository outside this app or contact support.`
    )
    this.name = 'CanvasOperationUncertainError'
  }
}

export function isCanvasOperationUncertainError(
  error: unknown
): error is CanvasOperationUncertainError {
  return error instanceof CanvasOperationUncertainError
}

export function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export function isCancelled(
  value: unknown
): value is Error & { canvasCancelled: true } {
  return (
    value instanceof Error && Reflect.get(value, 'canvasCancelled') === true
  )
}

export function isRejected(
  value: unknown
): value is Error & { canvasRejected: true } {
  return value instanceof Error && Reflect.get(value, 'canvasRejected') === true
}

export function isCanvasOperationCancellation(value: unknown) {
  return isCancelled(value)
}

export function canvasCancellation(reason: string) {
  const error = new Error(reason)
  Object.assign(error, { canvasCancelled: true })
  return error
}

export function canvasRejection(reason: string) {
  const error = new Error(reason)
  Object.assign(error, { canvasRejected: true })
  return error
}
