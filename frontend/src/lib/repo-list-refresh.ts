import type { RepoInfo } from '../../bindings/loom/internal/service'

export function createRepoListRefresh(
  fetchRepos: () => Promise<RepoInfo[] | null>,
  update: (repos: RepoInfo[]) => void
) {
  let requestId = 0
  let open = false
  const refresh = () => {
    if (!open) return Promise.resolve()
    const request = ++requestId
    return fetchRepos().then((repos) => {
      if (open && request === requestId) update(repos ?? [])
    })
  }

  const onFocus = () => void refresh()
  return {
    refresh,
    setOpen(nextOpen: boolean) {
      if (open === nextOpen) return
      open = nextOpen
      requestId++
      if (open) {
        window.addEventListener('focus', onFocus)
        void refresh()
      } else {
        window.removeEventListener('focus', onFocus)
      }
    },
    dispose() {
      open = false
      requestId++
      window.removeEventListener('focus', onFocus)
    },
  }
}
