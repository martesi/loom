import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import {
  readShortcutOverrides,
  shortcutOverridesKey,
  writeShortcutOverrides,
} from './shortcut-overrides'

const restoreEventSpies: Array<() => void> = []

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
  const eventSpy = spyOn(window, 'dispatchEvent').mockImplementation(
    (event) => {
      if (event.type === 'loom:shortcut-overrides-change')
        events.push(event.type)
      return true
    }
  )
  restoreEventSpies.push(() => eventSpy.mockRestore())
  return { values, events }
}

describe('shortcut overrides', () => {
  afterEach(() => {
    // Keep Happy DOM's real Window intact for component tests running beside
    // this suite. Replacing or deleting it leaks across Bun's test files.
    for (const restore of restoreEventSpies.splice(0)) restore()
    Reflect.deleteProperty(globalThis, 'localStorage')
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
