import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { RepoInfo } from '../../bindings/loom/internal/service'
import { RepoService } from '../../bindings/loom/internal/service'
import { setCurrentRepo } from '../lib/repo-store'
import { Landing } from './landing'
import { rootRoute } from './root'

function IndexPage() {
  const [repos, setRepos] = useState<RepoInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const navigate = useNavigate()

  const refresh = () => {
    RepoService.ListRecentRepos()
      .then((result) => setRepos(result ?? []))
      .finally(() => setLoaded(true))
  }

  useEffect(refresh, [])

  const enterRepo = (repo: RepoInfo) => {
    setCurrentRepo(repo)
    navigate({ to: '/board' })
  }

  const handleOpenFolder = () => {
    RepoService.OpenFolder().then((repo) => {
      if (repo) enterRepo(repo)
    })
  }

  const handleCreateRepo = () => {
    RepoService.CreateRepo().then((repo) => {
      if (repo) enterRepo(repo)
    })
  }

  const handleSelectRepo = (repo: { id: string }) => {
    RepoService.OpenRecent(repo.id).then((opened) => {
      if (opened) enterRepo(opened)
    })
  }

  if (!loaded) {
    return null
  }

  return (
    <Landing
      recentRepos={repos.map((r) => ({
        id: r.id,
        name: r.name,
        path: r.path,
        imageCount: r.imageCount,
        openedAt: r.openedAt,
      }))}
      onOpenFolder={handleOpenFolder}
      onCreateRepo={handleCreateRepo}
      onSelectRepo={handleSelectRepo}
    />
  )
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: IndexPage,
})
