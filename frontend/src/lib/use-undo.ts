import { t } from '@lingui/core/macro'
import {
  type UndoResult,
  UndoService,
} from '../../bindings/loom/internal/service'
import type { CanvasBoardExecutor } from '../components/canvas/canvas-board-executor'
import { useToast } from '../components/ui/toast'

// Failed inverses of hard-purge operations surface their reason through the app toast.
export function useUndoActions(
  repoPath: string,
  onChange: (result: UndoResult) => void | Promise<void>,
  executor?: CanvasBoardExecutor
) {
  const toast = useToast()

  async function run(redo: boolean) {
    const lifetime = executor?.getLifetimeRevision?.()
    const isCurrent = () =>
      (!executor?.isActive || executor.isActive()) &&
      (lifetime === undefined || executor?.getLifetimeRevision?.() === lifetime)
    if (!isCurrent()) return
    const result = redo
      ? await UndoService.Redo(repoPath)
      : await UndoService.Undo(repoPath)
    if (!result || !isCurrent()) return
    if (result.error) {
      toast.add({
        title: redo ? t`Couldn't redo` : t`Couldn't undo`,
        description: result.error,
        type: 'danger',
      })
      return
    }
    if (result.applied) {
      await onChange(result)
      if (!isCurrent()) return
    }
  }

  function enqueue(redo: boolean) {
    const lifetime = executor?.getLifetimeRevision?.()
    executor?.cancelGesture?.()
    return executor
      ? (executor.admit ?? executor.execute.bind(executor))(() => {
          if (
            lifetime !== undefined &&
            executor.getLifetimeRevision?.() !== lifetime
          )
            return Promise.resolve()
          return run(redo)
        }, false)
      : run(redo)
  }
  return { undo: () => enqueue(false), redo: () => enqueue(true) }
}
