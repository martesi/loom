import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useCurrentRepo, useHydrateRepo } from '../lib/repo-store'
import { Board } from './board'
import { rootRoute } from './root'

function CanvasPage() {
  const repo = useCurrentRepo(),
    hydrating = useHydrateRepo(),
    navigate = useNavigate()
  useEffect(() => {
    if (!repo && !hydrating) void navigate({ to: '/' })
  }, [repo, hydrating, navigate])
  return repo ? <Board key={repo.path} repo={repo} /> : null
}
export const boardIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/board',
  component: CanvasPage,
})
