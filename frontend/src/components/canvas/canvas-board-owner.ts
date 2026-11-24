import { useRef } from 'react'

export interface CanvasBoardExecutor {
  execute<T>(action: () => Promise<T>): Promise<T>
}

export function useCanvasBoardOwner(repoPath: string): CanvasBoardExecutor {
  const owner = useRef<{ repoPath: string; executor: CanvasBoardExecutor }>(
    null
  )
  if (!owner.current || owner.current.repoPath !== repoPath) {
    owner.current = { repoPath, executor: createCanvasBoardOwner() }
  }
  return owner.current.executor
}

function createCanvasBoardOwner(): CanvasBoardExecutor {
  let tail: Promise<void> = Promise.resolve()
  return {
    execute<T>(action: () => Promise<T>): Promise<T> {
      // Queue outer operations only: awaiting a nested execute would deadlock.
      const result = tail.then(action)
      tail = result.then(
        () => undefined,
        () => undefined
      )
      return result
    },
  }
}
