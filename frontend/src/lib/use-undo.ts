import { t } from '@lingui/core/macro'
import { useEffect } from 'react'
import { UndoService } from '../../bindings/loom/internal/service'
import { useToast } from '../components/ui/toast'

// Wires the Stage 1-reserved Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z (or Ctrl+Y on
// Windows) shortcuts to the Stage 5 undo/redo log. Undo is best-effort
// against hard-purge: a failed inverse surfaces its reason as a toast
// rather than failing silently (see UndoService.Undo/Redo doc comments).
export function useUndoShortcuts(repoPath: string, onChange: () => void) {
  const toast = useToast()

  useEffect(() => {
    const handler = async (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      if (!mod) return

      // Compare case-insensitively and key undo/redo off event.shiftKey
      // rather than the key's letter-case — Caps Lock flips 'z' to 'Z'
      // without shiftKey being true, which would otherwise misroute a
      // plain Ctrl/Cmd+Z (undo) into redo.
      const key = event.key.toLowerCase()
      const isRedo = (key === 'z' && event.shiftKey) || key === 'y'
      const isUndo = key === 'z' && !event.shiftKey

      if (!isUndo && !isRedo) return
      event.preventDefault()

      const result = isRedo
        ? await UndoService.Redo(repoPath)
        : await UndoService.Undo(repoPath)
      if (!result) return

      if (result.error) {
        toast.add({
          title: isRedo ? t`Couldn't redo` : t`Couldn't undo`,
          description: result.error,
          type: 'danger',
        })
        return
      }
      if (result.applied) {
        onChange()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [repoPath, onChange, toast])
}
