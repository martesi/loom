import { createRootRoute, Outlet } from '@tanstack/react-router'
import { useEffect } from 'react'
import { z } from 'zod'
import { SystemService } from '../../bindings/loom/internal/service'
import { Toaster, ToastProvider } from '../components/ui/toast'
import { setCapabilities } from '../lib/capabilities-store'

export const preferencesSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  density: z.enum(['comfortable', 'compact']).optional(),
  showTitle: z.boolean().optional(),
  showResolution: z.boolean().optional(),
  version: z.literal(1).optional(),
})
export type Preferences = { theme: 'system' | 'light' | 'dark'; density: 'comfortable' | 'compact'; showTitle: boolean; showResolution: boolean }
export const preferencesStorageKey = 'loom.preferences.v1'
export const defaultPreferences: Preferences = { theme: 'system', density: 'comfortable', showTitle: true, showResolution: true }

export function readPreferences(): { value: Preferences; failed: boolean } {
  let raw: string | null
  try {
    // why: browsers can throw when storage is blocked; TypeScript cannot model this platform failure.
    raw = localStorage.getItem(preferencesStorageKey)
  } catch (cause) {
    console.warn('Could not read saved preferences', cause)
    return { value: defaultPreferences, failed: true }
  }
  if (!raw) return { value: defaultPreferences, failed: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    console.warn('Saved preferences contain invalid JSON', cause)
    return { value: defaultPreferences, failed: false }
  }
  const result = preferencesSchema.safeParse(parsed)
  if (!result.success) {
    console.warn('Saved preferences are invalid', result.error)
    return { value: defaultPreferences, failed: false }
  }
  return {
    value: {
      theme: result.data.theme ?? defaultPreferences.theme,
      density: result.data.density ?? defaultPreferences.density,
      showTitle: result.data.showTitle ?? defaultPreferences.showTitle,
      showResolution: result.data.showResolution ?? defaultPreferences.showResolution,
    },
    failed: false,
  }
}

function applyPreferences(preferences: Preferences) {
  const root = document.documentElement
  root.dataset.theme =
    preferences.theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
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
      const parsed = preferencesSchema.safeParse((event as CustomEvent<unknown>).detail)
      if (!parsed.success) return
      preferences = {
        theme: parsed.data.theme ?? defaultPreferences.theme,
        density: parsed.data.density ?? defaultPreferences.density,
        showTitle: parsed.data.showTitle ?? defaultPreferences.showTitle,
        showResolution: parsed.data.showResolution ?? defaultPreferences.showResolution,
      }
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
