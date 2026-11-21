import { z } from 'zod'

export const preferencesSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  density: z.enum(['comfortable', 'compact']).optional(),
  showTitle: z.boolean().optional(),
  showResolution: z.boolean().optional(),
  version: z.literal(1).optional(),
})

export type Preferences = {
  theme: 'system' | 'light' | 'dark'
  density: 'comfortable' | 'compact'
  showTitle: boolean
  showResolution: boolean
}

export const preferencesStorageKey = 'loom.preferences.v1'

export const defaultPreferences: Preferences = {
  theme: 'system',
  density: 'comfortable',
  showTitle: true,
  showResolution: true,
}

/** Fill a parsed (possibly partial) preferences object with defaults. */
export function withPreferenceDefaults(
  value: z.infer<typeof preferencesSchema>
): Preferences {
  return {
    theme: value.theme ?? defaultPreferences.theme,
    density: value.density ?? defaultPreferences.density,
    showTitle: value.showTitle ?? defaultPreferences.showTitle,
    showResolution: value.showResolution ?? defaultPreferences.showResolution,
  }
}

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
  return { value: withPreferenceDefaults(result.data), failed: false }
}
