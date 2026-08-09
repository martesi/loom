import { useEffect, useState, useSyncExternalStore } from 'react'
import type { RepoInfo } from '../../bindings/loom/internal/service'
import { RepoService } from '../../bindings/loom/internal/service'

const STORAGE_KEY = 'loom.currentRepoPath'

let current: RepoInfo | null = null
const listeners = new Set<() => void>()

export function setCurrentRepo(repo: RepoInfo | null) {
  current = repo
  // Browser tabs get reloaded/restored by the browser far more often than
  // native windows ever get manually refreshed (a native window's URL is
  // never visited by hand) — persisting the path here lets
  // useHydrateRepo restore it after a reload instead of bouncing back to
  // the repo picker. sessionStorage is per-tab, matching one-repo-per-tab.
  try {
    if (repo) sessionStorage.setItem(STORAGE_KEY, repo.path)
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // sessionStorage can throw in locked-down contexts (private-browsing
    // limits, etc.) — reload-restoration is a nicety, not a hard
    // requirement, so just skip persisting it.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCurrentRepo() {
  return useSyncExternalStore(subscribe, () => current)
}

// Restores the in-memory current-repo store after a reload, from the path
// persisted by the last setCurrentRepo call in this tab. Returns whether a
// restore attempt is in flight, so board routes can hold off redirecting to
// the repo picker until it resolves (or fails, at which point they should
// redirect same as if nothing had been stored).
export function useHydrateRepo(): boolean {
  const repo = useCurrentRepo()
  const storedPath = repo ? null : safeGetItem(STORAGE_KEY)
  const [hydrating, setHydrating] = useState(!!storedPath)

  useEffect(() => {
    if (!storedPath) return
    let cancelled = false
    RepoService.OpenRecent(storedPath).then((opened) => {
      if (cancelled) return
      if (opened && !opened.openedElsewhere) setCurrentRepo(opened)
      setHydrating(false)
    })
    return () => {
      cancelled = true
    }
  }, [storedPath])

  return hydrating
}

function safeGetItem(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}
