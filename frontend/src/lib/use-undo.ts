import { t } from '@lingui/core/macro'
import { UndoService } from '../../bindings/loom/internal/service'
import { useToast } from '../components/ui/toast'

// Failed inverses of hard-purge operations surface their reason through the app toast.
export function useUndoActions(repoPath: string, onChange: () => void) {
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
    if (result.applied) onChange()
  }

  return {
    undo: () => run(false),
    redo: () => run(true),
  }
}
