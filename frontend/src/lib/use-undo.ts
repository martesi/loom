import { t } from '@lingui/core/macro'
import type { CanvasBoardOwner } from '../components/canvas/canvas-board-owner'
import { unwrapCanvasOutcome } from '../components/canvas/canvas-operation'
import { canvasEffects } from '../components/canvas/canvas-operation-effects'
import { useToast } from '../components/ui/toast'

export function useUndoActions(repoPath: string, owner: CanvasBoardOwner) {
  const toast = useToast()

  async function run(redo: boolean) {
    const operation = await owner.submit(
      { kind: 'history', board: owner.getSnapshot() },
      async (context) => {
        const result = await (redo
          ? canvasEffects.redo(context, repoPath)
          : canvasEffects.undo(context, repoPath))
        if (result?.applied) owner.stageHistory(result)
        return result
      }
    )
    if (operation.status === 'cancelled') return
    const result = unwrapCanvasOutcome(operation)
    if (!result || result.error) {
      toast.add({
        title: redo ? t`Couldn't redo` : t`Couldn't undo`,
        description: result?.error ?? t`Canvas history is unavailable.`,
        type: 'danger',
      })
    }
  }

  return { undo: () => run(false), redo: () => run(true) }
}
