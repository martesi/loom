import { z } from 'zod'
import { normalizeShortcut } from './action-catalog'

const overridesSchema = z.record(z.string(), z.string())

export const shortcutOverridesKey = 'loom.shortcuts.v1'
export const shortcutOverridesEvent = 'loom:shortcut-overrides-change'

function sanitize(raw: unknown): Record<string, string> {
  const parsed = overridesSchema.safeParse(raw)
  if (!parsed.success) return {}
  const clean: Record<string, string> = {}
  for (const [id, shortcut] of Object.entries(parsed.data)) {
    if (id && shortcut) clean[id] = normalizeShortcut(shortcut)
  }
  return clean
}

export function readShortcutOverrides(): Record<string, string> {
  let raw: string | null
  // localStorage access throws in restricted contexts (private mode, blocked
  // storage); the throwing storage API is the only failure signal here.
  try {
    raw = localStorage.getItem(shortcutOverridesKey)
  } catch {
    return {}
  }
  if (!raw) return {}
  // JSON.parse only reports malformed input by throwing an untyped SyntaxError.
  try {
    return sanitize(JSON.parse(raw))
  } catch {
    return {}
  }
}

export function writeShortcutOverrides(next: Record<string, string>): void {
  // Best-effort persistence: warn and still notify listeners when storage throws.
  try {
    localStorage.setItem(shortcutOverridesKey, JSON.stringify(next))
  } catch (cause) {
    console.warn('Could not save shortcut overrides', cause)
  }
  window.dispatchEvent(new CustomEvent(shortcutOverridesEvent))
}

export function shortcutParts(shortcut: string): string[] {
  return normalizeShortcut(shortcut).split('+').filter(Boolean)
}
