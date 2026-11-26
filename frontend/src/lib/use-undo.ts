import { t } from '@lingui/core/macro'
import { useRef } from 'react'
import {
  type HistoryReplayStatus,
  type HistorySelection,
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
  selection?: HistorySelection
}

interface StoredIntent {
  requestID: string
  selection?: HistorySelection
}

interface RestoredRequests {
  repoPath: string
  undo: StoredIntent | null
  redo: StoredIntent | null
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
    let selection =
      action.selection ??
      readIntent(action.repoPath, action.direction)?.selection
    persistRequest(action.repoPath, action.direction, requestID, selection)
    let status: HistoryReplayStatus | null
    if (!selection && action.retryOnly) {
      status = await UndoService.SettleHistoryReplay(
        action.repoPath,
        requestID,
        action.direction,
        ''
      )
    } else {
      if (!selection) {
        const selected = await UndoService.SelectHistoryReplay(
          action.repoPath,
          action.direction
        )
        if (!selected) throw new Error('History selection was unavailable')
        selection = selected
        persistRequest(action.repoPath, action.direction, requestID, selection)
      }
      status = await UndoService.ReserveHistoryReplay(
        action.repoPath,
        requestID,
        selection
      )
    }
    if (status?.state === 'reserved') {
      status = await UndoService.ExecuteHistoryReplay(
        action.repoPath,
        requestID
      )
    }
    const result = status?.result
    if (action.executor?.isActive && !action.executor.isActive()) return false
    if (!result) {
      toast.add({
        title:
          action.direction === 'redo'
            ? t`Redo needs recovery`
            : t`Undo needs recovery`,
        description:
          status?.reason ??
          t`The replay outcome is not confirmed. Retry this action to settle it.`,
        type: 'danger',
      })
      return false
    }
    if (
      status?.state === 'reserved' ||
      status?.state === 'inspection' ||
      status?.state === 'unknown'
    ) {
      toast.add({
        title:
          action.direction === 'redo'
            ? t`Redo needs recovery`
            : t`Undo needs recovery`,
        description: status.reason ?? result.error,
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
    const storedIntent = readIntent(action.repoPath, action.direction)
    if (action.retryOnly) {
      if (storedRequestID === action.requestID) {
        await invoke(
          { ...action, selection: storedIntent?.selection },
          action.requestID
        )
      }
      return
    }
    if (storedRequestID && storedRequestID !== action.requestID) {
      const resolved = await invoke(
        { ...action, retryOnly: true, selection: storedIntent?.selection },
        storedRequestID
      )
      if (!resolved) return
    }
    await invoke(
      { ...action, selection: storedIntent?.selection },
      action.requestID
    )
  }

  function enqueue(direction: Direction, retryOnly = false) {
    const wasRestored = claimRestoredRequest(direction)
    const requestID = retryOnly
      ? readRequest(repoPath, direction)
      : wasRestored
        ? (restored.current[direction]?.requestID ?? null)
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
  return readIntent(repoPath, direction)?.requestID ?? null
}

function readIntent(
  repoPath: string,
  direction: Direction
): StoredIntent | null {
  const value = window.localStorage.getItem(
    requestStorageKey(repoPath, direction)
  )
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      parsed &&
      typeof parsed === 'object' &&
      'requestID' in parsed &&
      typeof parsed.requestID === 'string'
    ) {
      return parsed as StoredIntent
    }
  } catch {
    // Legacy request-ID-only entries are settled without selecting new history.
  }
  return { requestID: value }
}

function persistRequest(
  repoPath: string,
  direction: Direction,
  requestID: string,
  selection?: HistorySelection
) {
  window.localStorage.setItem(
    requestStorageKey(repoPath, direction),
    JSON.stringify({ requestID, selection } satisfies StoredIntent)
  )
}

function clearRequest(
  repoPath: string,
  direction: Direction,
  requestID: string
) {
  const key = requestStorageKey(repoPath, direction)
  if (readIntent(repoPath, direction)?.requestID === requestID) {
    window.localStorage.removeItem(key)
  }
}

function loadRestoredRequests(repoPath: string): RestoredRequests {
  return {
    repoPath,
    undo: readIntent(repoPath, 'undo'),
    redo: readIntent(repoPath, 'redo'),
    undoClaimed: false,
    redoClaimed: false,
  }
}
