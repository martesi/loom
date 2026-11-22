import type { RepoInfo } from '../../bindings/loom/internal/service'

export function createRepoListRefresh(
  fetchRepos: () => Promise<RepoInfo[] | null>,
  update: (repos: RepoInfo[]) => void
) {
  let requestId = 0
  return () => {
    const request = ++requestId
    return fetchRepos().then((repos) => {
      if (request === requestId) update(repos ?? [])
    })
  }
}

export function listenForWindowFocus(open: boolean, refresh: () => void) {
  if (!open) return () => {}
  window.addEventListener('focus', refresh)
  return () => window.removeEventListener('focus', refresh)
}
