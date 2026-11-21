import { afterEach, describe, expect, it } from 'bun:test'
import {
  readShortcutOverrides,
  shortcutOverridesKey,
  writeShortcutOverrides,
} from './shortcut-overrides'

function useBrowser(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const events: string[] = []
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
      clear: () => values.clear(),
      key: () => null,
      length: 0,
    },
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dispatchEvent: (event: Event) => {
        events.push(event.type)
        return true
      },
    },
  })
  return { values, events }
}

describe('shortcut overrides', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage')
    Reflect.deleteProperty(globalThis, 'window')
  })

  it('returns no overrides when nothing is stored', () => {
    useBrowser()
    expect(readShortcutOverrides()).toEqual({})
  })

  it('normalizes stored shortcuts and drops empty entries', () => {
    useBrowser({
      [shortcutOverridesKey]: JSON.stringify({
        'canvas.preview': 'ControlOrMeta+Shift+P',
        'canvas.focus': '',
        '': 'Mod+K',
      }),
    })
    expect(readShortcutOverrides()).toEqual({
      'canvas.preview': 'mod+shift+p',
    })
  })

  it('ignores corrupt stored values', () => {
    useBrowser({ [shortcutOverridesKey]: '{not valid json' })
    expect(readShortcutOverrides()).toEqual({})
  })

  it('writes overrides and notifies listeners', () => {
    const { values, events } = useBrowser()
    writeShortcutOverrides({ 'canvas.preview': 'mod+p' })

    expect(values.get(shortcutOverridesKey)).toBe(
      JSON.stringify({ 'canvas.preview': 'mod+p' })
    )
    expect(events).toEqual(['loom:shortcut-overrides-change'])
  })
})
