import { t } from '@lingui/core/macro'
import { useRef } from 'react'
import {
  type UndoResult,
  UndoService,
} from '../../bindings/loom/internal/service'
import type { CanvasBoardExecutor } from '../components/canvas/canvas-board-owner'
import { useToast } from '../components/ui/toast'

type Direction = 'undo' | 'redo'

interface ReplayAction {
  direction: Direction
  requestID: string
  repoPath: string
  executor?: CanvasBoardExecutor
  onChange: (result: UndoResult) => void | Promise<void>
  retryOnly: boolean
}

interface RestoredRequests {
  repoPath: string
  undo: string | null
  redo: string | null
  undoClaimed: boolean
  redoClaimed: boolean
}

const requestStoragePrefix = 'loom:history-replay:v1:'

// Failed inverses of hard-purge operations surface their reason through the app toast.
export function useUndoActions(
  repoPath: string,
  onChange: (result: UndoResult) => void | Promise<void>,
  executor?: CanvasBoardExecutor
) {
  const toast = useToast()
  const restored = useRef<RestoredRequests>(loadRestoredRequests(repoPath))
  if (restored.current.repoPath !== repoPath) {
    restored.current = loadRestoredRequests(repoPath)
  }
  const localQueue = useRef<Promise<void>>(Promise.resolve())

  async function invoke(action: ReplayAction, requestID: string) {
    if (action.executor?.isActive && !action.executor.isActive()) return false
    persistRequest(action.repoPath, action.direction, requestID)
    const result =
      action.direction === 'redo'
        ? await UndoService.RedoWithRequest(action.repoPath, requestID)
        : await UndoService.UndoWithRequest(action.repoPath, requestID)
    if (!result || (action.executor?.isActive && !action.executor.isActive()))
      return false
    if (result.pendingRecovery) {
      toast.add({
        title:
          action.direction === 'redo'
            ? t`Redo needs recovery`
            : t`Undo needs recovery`,
        description: result.error,
        type: 'danger',
      })
      return false
    }
    clearRequest(action.repoPath, action.direction, requestID)
    if (result.error) {
      toast.add({
        title:
          action.direction === 'redo' ? t`Couldn't redo` : t`Couldn't undo`,
        description: result.error,
        type: 'danger',
      })
      return true
    }
    if (result.applied) await onChange(result)
    return true
  }

  async function run(action: ReplayAction) {
    if (action.executor?.isActive && !action.executor.isActive()) return
    const storedRequestID = readRequest(action.repoPath, action.direction)
    if (action.retryOnly) {
      if (storedRequestID === action.requestID) {
        await invoke(action, action.requestID)
      }
      return
    }
    if (storedRequestID && storedRequestID !== action.requestID) {
      const resolved = await invoke(action, storedRequestID)
      if (!resolved) return
    }
    await invoke(action, action.requestID)
  }

  function enqueue(direction: Direction, retryOnly = false) {
    const wasRestored = claimRestoredRequest(direction)
    const requestID = retryOnly
      ? readRequest(repoPath, direction)
      : wasRestored
        ? restored.current[direction]
        : null
    if (retryOnly && !requestID) return Promise.resolve()
    executor?.cancelGesture?.()
    const action: ReplayAction = {
      direction,
      requestID: requestID ?? crypto.randomUUID(),
      repoPath,
      executor,
      onChange,
      retryOnly: retryOnly || wasRestored,
    }
    const execute = () => run(action)
    if (executor) return executor.execute(execute)
    const result = localQueue.current.then(execute)
    localQueue.current = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  function claimRestoredRequest(direction: Direction) {
    const claimedKey = direction === 'undo' ? 'undoClaimed' : 'redoClaimed'
    const idKey = direction
    if (restored.current[claimedKey]) return false
    restored.current[claimedKey] = true
    return restored.current[idKey] !== null
  }

  return {
    undo: () => enqueue('undo'),
    redo: () => enqueue('redo'),
    retryUndo: () => enqueue('undo', true),
    retryRedo: () => enqueue('redo', true),
  }
}

function requestStorageKey(repoPath: string, direction: Direction) {
  return `${requestStoragePrefix}${encodeURIComponent(repoPath)}:${direction}`
}

function readRequest(repoPath: string, direction: Direction) {
  return window.localStorage.getItem(requestStorageKey(repoPath, direction))
}

function persistRequest(
  repoPath: string,
  direction: Direction,
  requestID: string
) {
  window.localStorage.setItem(requestStorageKey(repoPath, direction), requestID)
}

function clearRequest(
  repoPath: string,
  direction: Direction,
  requestID: string
) {
  const key = requestStorageKey(repoPath, direction)
  if (window.localStorage.getItem(key) === requestID) {
    window.localStorage.removeItem(key)
  }
}

function loadRestoredRequests(repoPath: string): RestoredRequests {
  return {
    repoPath,
    undo: readRequest(repoPath, 'undo'),
    redo: readRequest(repoPath, 'redo'),
    undoClaimed: false,
    redoClaimed: false,
  }
}
