import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useCurrentRepo } from '../lib/repo-store'
import { Board } from './board'
import { rootRoute } from './root'

function BoardPage() {
  const repo = useCurrentRepo()
  const navigate = useNavigate()

  useEffect(() => {
    if (!repo) {
      navigate({ to: '/' })
    }
  }, [repo, navigate])

  if (!repo) {
    return null
  }

  return <Board repo={repo} />
}

export const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/board',
  component: BoardPage,
})
