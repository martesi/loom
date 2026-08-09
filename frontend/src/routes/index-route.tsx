import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { RepoInfo } from '../../bindings/loom/internal/service'
import { RepoService } from '../../bindings/loom/internal/service'
import { RepoPickerModal } from '../components/repo-picker-modal'
import { useCapabilities } from '../lib/capabilities-store'
import { setCurrentRepo } from '../lib/repo-store'
import { Landing } from './landing'
import { rootRoute } from './root'

function IndexPage() {
  const [repos, setRepos] = useState<RepoInfo[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const navigate = useNavigate()
  const capabilities = useCapabilities()

  // Windows spawned by RepoService.SwitchTo (the repo-switcher, Stage 10)
  // open straight to "/?openRepo=<path>" instead of the Landing page — a
  // window's Name is fixed at creation, so this query param is how a
  // freshly spawned window learns which repo it exists to show. When
  // present, skip the recent-repos fetch and jump to the board.
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
      .catch((error) => {
        // The landing page is still useful when the native RPC is
        // temporarily unavailable (notably while running WebKitGTK under
        // WSL). Keep the UI visible and let the user try opening a repo.
        console.error('failed to load recent repositories', error)
      })
  }, [navigate])

  const enterRepo = (repo: RepoInfo) => {
    // OpenedElsewhere means the repo was already open in another window,
    // which was focused instead — this window must not navigate itself
    // into a repo it isn't actually showing.
    if (repo.openedElsewhere) return
    setCurrentRepo(repo)
    navigate({ to: '/board' })
  }

  // Server mode has no native folder dialog (Dialog.OpenFile isn't
  // available when built headless — see main_server.go), so both entry
  // points open the browser-side folder-tree picker instead; desktop mode
  // keeps calling the native dialogs unchanged.
  const handleOpenFolder = () => {
    if (capabilities.isServerMode) {
      setPickerOpen(true)
      return
    }
    RepoService.OpenFolder().then((repo) => {
      if (repo) enterRepo(repo)
    })
  }

  const handleCreateRepo = () => {
    if (capabilities.isServerMode) {
      setPickerOpen(true)
      return
    }
    RepoService.CreateRepo().then((repo) => {
      if (repo) enterRepo(repo)
    })
  }

  const handlePickerSelect = (path: string) => {
    setPickerOpen(false)
    RepoService.OpenRecent(path).then((opened) => {
      if (opened) enterRepo(opened)
    })
  }

  const handleSelectRepo = (repo: { id: string }) => {
    RepoService.OpenRecent(repo.id).then((opened) => {
      if (opened) enterRepo(opened)
    })
  }

  return (
    <>
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
      <RepoPickerModal
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={handlePickerSelect}
      />
    </>
  )
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: IndexPage,
})
