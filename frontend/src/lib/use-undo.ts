import { t } from '@lingui/core/macro'
import { useRef } from 'react'
import {
  type UndoResult,
  UndoService,
} from '../../bindings/loom/internal/service'
import type { CanvasBoardExecutor } from '../components/canvas/canvas-board-owner'
import { useToast } from '../components/ui/toast'

// Failed inverses of hard-purge operations surface their reason through the app toast.
export function useUndoActions(
  repoPath: string,
  onChange: (result: UndoResult) => void | Promise<void>,
  executor?: CanvasBoardExecutor
) {
  const toast = useToast()
  const requestIDs = useRef<{ undo: string | null; redo: string | null }>({
    undo: null,
    redo: null,
  })

  async function run(redo: boolean, requestID: string) {
    if (executor?.isActive && !executor.isActive()) return
    const result = redo
      ? await UndoService.RedoWithRequest(repoPath, requestID)
      : await UndoService.UndoWithRequest(repoPath, requestID)
    if (!result || (executor?.isActive && !executor.isActive())) return
    const key = redo ? 'redo' : 'undo'
    if (result.pendingRecovery) {
      toast.add({
        title: redo ? t`Redo needs recovery` : t`Undo needs recovery`,
        description: result.error,
        type: 'danger',
      })
      return
    }
    if (result.error) {
      requestIDs.current[key] = null
      toast.add({
        title: redo ? t`Couldn't redo` : t`Couldn't undo`,
        description: result.error,
        type: 'danger',
      })
      return
    }
    requestIDs.current[key] = null
    if (result.applied) await onChange(result)
  }

  function enqueue(redo: boolean) {
    executor?.cancelGesture?.()
    const key = redo ? 'redo' : 'undo'
    const requestID = requestIDs.current[key] ?? crypto.randomUUID()
    requestIDs.current[key] = requestID
    return executor
      ? executor.execute(() => run(redo, requestID))
      : run(redo, requestID)
  }
  return { undo: () => enqueue(false), redo: () => enqueue(true) }
}
