import { useSyncExternalStore } from 'react'

export interface Capabilities {
  // Mirrors SystemService.IsServerMode() — true when this page is being
  // served by the headless web-server build rather than the native desktop
  // app. Drives every native-vs-browser UI branch (repo picker, "switch
  // repo" behavior, reveal-in-file-explorer visibility).
  isServerMode: boolean
}

// Defaults to native desktop until the root route resolves the runtime mode.
let current: Capabilities = { isServerMode: false }
const listeners = new Set<() => void>()

export function setCapabilities(capabilities: Capabilities) {
  current = capabilities
  for (const listener of listeners) listener()
}

export function getCapabilities() {
  return current
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCapabilities() {
  return useSyncExternalStore(subscribe, () => current)
}
