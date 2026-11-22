import type { RepoInfo } from '../../bindings/loom/internal/service'

export function enterRepo(
  repo: RepoInfo,
  setRepo: (repo: RepoInfo) => void,
  navigate: () => void
) {
  if (repo.openedElsewhere) return
  setRepo(repo)
  navigate()
}
