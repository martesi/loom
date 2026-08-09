import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useEffect, useRef, useState } from 'react'
import type { BoardSummary } from '../../../bindings/loom/internal/service'
import { BoardService } from '../../../bindings/loom/internal/service'
import { cn } from '../../lib/utils'

interface BoardPickerProps {
  x: number
  y: number
  repoPath: string
  imageIds: number[]
  boards: BoardSummary[]
  onClose: () => void
  onChange: () => void
}

// "Add to board" / batch board-assign popover — the only board-population
// mechanism, per spec ("New image -> board assignment": placement is
// always explicit). Membership checkmarks only reflect a single selected
// image (batch selections show everything as unchecked — "toggle" then
// just adds all of them, which is the common case for a fresh batch).
export function BoardPicker({
  x,
  y,
  repoPath,
  imageIds,
  boards,
  onClose,
  onChange,
}: BoardPickerProps) {
  const [newName, setNewName] = useState('')
  const [memberBoardIds, setMemberBoardIds] = useState<number[]>([])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (imageIds.length === 1) {
      BoardService.BoardsForImage(repoPath, imageIds[0]).then((b) =>
        setMemberBoardIds((b ?? []).map((board) => board.id))
      )
    }
  }, [repoPath, imageIds])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [onClose])

  const toggle = async (boardId: number, member: boolean) => {
    if (member) {
      await BoardService.RemoveImagesFromBoard(repoPath, boardId, imageIds)
      setMemberBoardIds((prev) => prev.filter((id) => id !== boardId))
    } else {
      await BoardService.AddImagesToBoard(repoPath, boardId, imageIds)
      setMemberBoardIds((prev) => [...prev, boardId])
    }
    onChange()
  }

  const createAndAdd = async () => {
    const name = newName.trim()
    if (!name) return
    const board = await BoardService.CreateBoard(repoPath, name)
    if (board) {
      await BoardService.AddImagesToBoard(repoPath, board.id, imageIds)
      onChange()
    }
    setNewName('')
  }

  return (
    <div
      ref={ref}
      className="fixed z-50 flex w-60 flex-col gap-1 rounded-lg border border-black/8 bg-white p-2 shadow-lg"
      style={{ left: x, top: y }}
    >
      <div className="max-h-52 overflow-y-auto">
        {boards.map((b) => {
          const member = memberBoardIds.includes(b.id)
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => toggle(b.id, member)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-ink hover:bg-black/[0.04]"
            >
              <span
                className={cn(
                  'flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border',
                  member ? 'border-primary bg-primary' : 'border-black/20'
                )}
              />
              {b.name}
            </button>
          )
        })}
        {boards.length === 0 && (
          <div className="px-2 py-1.5 text-[11.5px] text-ink-subtle">
            <Trans>No boards yet</Trans>
          </div>
        )}
      </div>
      <div className="mt-1 flex gap-1 border-t border-black/6 pt-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') createAndAdd()
            e.stopPropagation()
          }}
          placeholder={t`New board…`}
          className="min-w-0 flex-1 rounded-md border border-black/12 px-2 py-1 text-[11.5px] outline-none focus:border-primary"
        />
      </div>
    </div>
  )
}
