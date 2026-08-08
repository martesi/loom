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

  // Windows spawned by RepoService.SwitchTo (the repo-switcher, Stage 10)
  // open straight to "/?openRepo=<path>" instead of the Landing page — a
  // window's Name is fixed at creation, so this query param is how a
  // freshly spawned window learns which repo it exists to show. When
  // present, skip the recent-repos fetch/Landing entirely and jump to the
  // board; `loaded` is deliberately left false in that branch so this
  // component renders nothing while the navigation is in flight.
  useEffect(() => {
    const openRepo = new URLSearchParams(window.location.search).get('openRepo')
    if (openRepo) {
      RepoService.OpenRecent(openRepo).then((repo) => {
        if (repo && !repo.openedElsewhere) {
          setCurrentRepo(repo)
          navigate({ to: '/board' })
        }
      })
      return
    }
    RepoService.ListRecentRepos()
      .then((result) => setRepos(result ?? []))
      .finally(() => setLoaded(true))
  }, [navigate])

  const enterRepo = (repo: RepoInfo) => {
    // OpenedElsewhere means the repo was already open in another window,
    // which was focused instead — this window must not navigate itself
    // into a repo it isn't actually showing.
    if (repo.openedElsewhere) return
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
