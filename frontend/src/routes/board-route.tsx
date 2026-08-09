import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { BoardService } from '../../bindings/loom/internal/service'
import { Button } from '../components/ui/button'
import { useCurrentRepo, useHydrateRepo } from '../lib/repo-store'
import { Board } from './board'
import { rootRoute } from './root'

// /board with no id: resolves to the first existing board, or offers to
// create one — a repo can be opened with zero boards (all images start
// unsorted, see "New image -> board assignment"), so this isn't just a
// redirect.
function BoardIndexPage() {
  const repo = useCurrentRepo()
  const hydrating = useHydrateRepo()
  const navigate = useNavigate()
  const [boards, setBoards] = useState<Awaited<
    ReturnType<typeof BoardService.ListBoards>
  > | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (repo || hydrating) return
    navigate({ to: '/' })
  }, [repo, hydrating, navigate])

  useEffect(() => {
    if (!repo) return
    BoardService.ListBoards(repo.path).then((list) => setBoards(list ?? []))
  }, [repo])

  useEffect(() => {
    if (boards && boards.length > 0) {
      navigate({
        to: '/board/$boardId',
        params: { boardId: String(boards[0].id) },
      })
    }
  }, [boards, navigate])

  const handleCreate = async () => {
    if (!repo) return
    setCreating(true)
    const board = await BoardService.CreateBoard(repo.path, t`Board 1`)
    setCreating(false)
    if (board) {
      navigate({ to: '/board/$boardId', params: { boardId: String(board.id) } })
    }
  }

  if (!repo || boards === null || boards.length > 0) {
    return null
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-surface-canvas text-center">
      <div className="text-[15px] font-semibold text-ink">
        <Trans>No boards yet</Trans>
      </div>
      <div className="max-w-sm text-[12.5px] text-ink-subtle">
        <Trans>
          Boards are scoped canvases you place images onto explicitly. Create
          one to start arranging images.
        </Trans>
      </div>
      <div className="flex gap-2">
        <Button onClick={handleCreate} disabled={creating}>
          <Trans>Create board</Trans>
        </Button>
      </div>
    </div>
  )
}

export const boardIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/board',
  component: BoardIndexPage,
})

function BoardPage() {
  const repo = useCurrentRepo()
  const hydrating = useHydrateRepo()
  const navigate = useNavigate()
  const { boardId } = boardRoute.useParams()

  useEffect(() => {
    if (repo || hydrating) return
    navigate({ to: '/' })
  }, [repo, hydrating, navigate])

  if (!repo) {
    return null
  }

  return <Board repo={repo} boardId={Number(boardId)} />
}

export const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/board/$boardId',
  component: BoardPage,
})
