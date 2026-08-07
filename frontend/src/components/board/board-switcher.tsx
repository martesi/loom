import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { BoardSummary } from '../../../bindings/loom/internal/service'
import { BoardService } from '../../../bindings/loom/internal/service'
import { cn } from '../../lib/utils'

interface BoardSwitcherProps {
  repoPath: string
  boards: BoardSummary[]
  currentBoardId: number
  currentBoardName: string
  onBoardsChanged: () => void
}

// Board = a scoped canvas (Stage 3 core). This is the only navigation
// mechanism between boards, plus create/rename/delete.
export function BoardSwitcher({
  repoPath,
  boards,
  currentBoardId,
  currentBoardName,
  onBoardsChanged,
}: BoardSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setCreating(false)
        setRenamingId(null)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    const board = await BoardService.CreateBoard(repoPath, name)
    setNewName('')
    setCreating(false)
    onBoardsChanged()
    if (board) {
      navigate({ to: '/board/$boardId', params: { boardId: String(board.id) } })
    }
  }

  const handleDelete = async (boardId: number) => {
    await BoardService.DeleteBoard(repoPath, boardId)
    onBoardsChanged()
    if (boardId === currentBoardId) {
      navigate({ to: '/board' })
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-semibold text-ink hover:bg-black/[0.04]"
      >
        {currentBoardName}
        <ChevronDown className="h-3.5 w-3.5 text-ink-subtle" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border border-black/8 bg-white p-1.5 shadow-lg">
          {boards.map((b) => (
            <div
              key={b.id}
              className={cn(
                'group flex items-center gap-1 rounded-md px-2 py-1.5',
                b.id === currentBoardId
                  ? 'bg-accent-soft'
                  : 'hover:bg-black/[0.04]'
              )}
            >
              {renamingId === b.id ? (
                <input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter') {
                      await BoardService.RenameBoard(
                        repoPath,
                        b.id,
                        renameValue.trim() || b.name
                      )
                      setRenamingId(null)
                      onBoardsChanged()
                    }
                  }}
                  onBlur={() => setRenamingId(null)}
                  className="min-w-0 flex-1 rounded border border-accent px-1 py-0.5 text-[12.5px] outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    navigate({
                      to: '/board/$boardId',
                      params: { boardId: String(b.id) },
                    })
                  }}
                  className="min-w-0 flex-1 truncate text-left text-[12.5px] text-ink"
                >
                  {b.name}{' '}
                  <span className="text-ink-subtle">({b.imageCount})</span>
                </button>
              )}
              <button
                type="button"
                title={t`Rename`}
                onClick={() => {
                  setRenamingId(b.id)
                  setRenameValue(b.name)
                }}
                className="hidden shrink-0 text-ink-subtle hover:text-ink group-hover:block"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                title={t`Delete board`}
                onClick={() => handleDelete(b.id)}
                className="hidden shrink-0 text-ink-subtle hover:text-danger group-hover:block"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}

          <div className="mt-1 border-t border-black/6 pt-1.5">
            {creating ? (
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                onBlur={handleCreate}
                placeholder={t`Board name…`}
                className="w-full rounded-md border border-accent px-2 py-1 text-[12.5px] outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] font-semibold text-accent hover:bg-black/[0.04]"
              >
                <Plus className="h-3.5 w-3.5" />
                <Trans>New board</Trans>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
