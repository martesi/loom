import { createRootRoute, Outlet } from '@tanstack/react-router'
import { useEffect } from 'react'
import { SystemService } from '../../bindings/loom/internal/service'
import { Toaster, ToastProvider } from '../components/ui/toast'
import { setCapabilities } from '../lib/capabilities-store'
import {
  type Preferences,
  preferencesSchema,
  preferencesStorageKey,
  readPreferences,
  withPreferenceDefaults,
} from '../lib/preferences'

function applyPreferences(preferences: Preferences) {
  const root = document.documentElement
  root.dataset.theme =
    preferences.theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : preferences.theme
  root.dataset.density = preferences.density
  root.dataset.showTitle = String(preferences.showTitle)
  root.dataset.showResolution = String(preferences.showResolution)
}

function Root() {
  // Fetched once per page load and cached in capabilities-store — every
  // route reads it from there rather than re-querying.
  useEffect(() => {
    SystemService.IsServerMode().then((isServerMode) => {
      setCapabilities({ isServerMode })
    })
  }, [])

  useEffect(() => {
    const result = readPreferences()
    let preferences = result.value
    applyPreferences(preferences)
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => applyPreferences(preferences)
    media.addEventListener('change', apply)
    const storage = (event: StorageEvent) => {
      if (event.key !== preferencesStorageKey && event.key !== null) return
      const next = readPreferences()
      preferences = next.value
      apply()
    }
    const updated = (event: Event) => {
      const parsed = preferencesSchema.safeParse(
        (event as CustomEvent<unknown>).detail
      )
      if (!parsed.success) return
      preferences = withPreferenceDefaults(parsed.data)
      apply()
    }
    window.addEventListener('storage', storage)
    window.addEventListener('loom:preferences-change', updated)
    return () => {
      media.removeEventListener('change', apply)
      window.removeEventListener('storage', storage)
      window.removeEventListener('loom:preferences-change', updated)
    }
  }, [])

  return (
    <ToastProvider>
      <Outlet />
      <Toaster />
    </ToastProvider>
  )
}

export const rootRoute = createRootRoute({
  component: Root,
})
