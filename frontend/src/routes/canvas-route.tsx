import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useCurrentRepo, useHydrateRepo } from '../lib/repo-store'
import { CanvasWorkspace } from './canvas'
import { rootRoute } from './root'

function CanvasPage() {
  const repo = useCurrentRepo(),
    hydrating = useHydrateRepo(),
    navigate = useNavigate()
  useEffect(() => {
    if (!repo && !hydrating) void navigate({ to: '/' })
  }, [repo, hydrating, navigate])
  return repo ? <CanvasWorkspace key={repo.path} repo={repo} /> : null
}
export const canvasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/canvas',
  component: CanvasPage,
})
