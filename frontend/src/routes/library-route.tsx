import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useCurrentRepo } from '../lib/repo-store'
import { Library } from './library'
import { rootRoute } from './root'

function LibraryPage() {
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

  return <Library repo={repo} />
}

export const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library',
  component: LibraryPage,
})
