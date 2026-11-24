import { t } from '@lingui/core/macro'
import { UndoService } from '../../bindings/loom/internal/service'
import type { CanvasBoardExecutor } from '../components/canvas/canvas-board-owner'
import { useToast } from '../components/ui/toast'

// Failed inverses of hard-purge operations surface their reason through the app toast.
export function useUndoActions(
  repoPath: string,
  onChange: () => void | Promise<void>,
  executor?: CanvasBoardExecutor
) {
  const toast = useToast()

  async function run(redo: boolean) {
    const result = redo
      ? await UndoService.Redo(repoPath)
      : await UndoService.Undo(repoPath)
    if (!result) return
    if (result.error) {
      toast.add({
        title: redo ? t`Couldn't redo` : t`Couldn't undo`,
        description: result.error,
        type: 'danger',
      })
      return
    }
    if (result.applied) await onChange()
  }

  function enqueue(redo: boolean) {
    executor?.cancelGesture?.()
    return executor ? executor.execute(() => run(redo)) : run(redo)
  }
  return { undo: () => enqueue(false), redo: () => enqueue(true) }
}
