import { useSyncExternalStore } from 'react'
import type { RepoInfo } from '../../bindings/loom/internal/service'

let current: RepoInfo | null = null
const listeners = new Set<() => void>()

export function setCurrentRepo(repo: RepoInfo | null) {
  current = repo
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCurrentRepo() {
  return useSyncExternalStore(subscribe, () => current)
}
