import { afterEach, describe, expect, it, vi } from 'bun:test'
import {
  defaultPreferences,
  preferencesStorageKey,
  readPreferences,
} from './preferences'

function useStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  })
  return values
}

describe('preferences', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    Reflect.deleteProperty(globalThis, 'localStorage')
  })

  it('uses defaults when nothing is stored', () => {
    useStorage()
    expect(readPreferences()).toEqual({
      value: defaultPreferences,
      failed: false,
    })
  })

  it('reads stored values and fills omitted fields with defaults', () => {
    useStorage({
      [preferencesStorageKey]: JSON.stringify({
        theme: 'dark',
        density: 'compact',
        version: 1,
      }),
    })
    expect(readPreferences()).toEqual({
      value: {
        ...defaultPreferences,
        theme: 'dark',
        density: 'compact',
      },
      failed: false,
    })
  })

  it('falls back without a storage failure for corrupt or invalid values', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    useStorage({ [preferencesStorageKey]: '{not valid json' })
    expect(readPreferences()).toEqual({
      value: defaultPreferences,
      failed: false,
    })

    useStorage({
      [preferencesStorageKey]: JSON.stringify({ theme: 'neon' }),
    })
    expect(readPreferences()).toEqual({
      value: defaultPreferences,
      failed: false,
    })

    useStorage({
      [preferencesStorageKey]: JSON.stringify({ version: 2 }),
    })
    expect(readPreferences()).toEqual({
      value: defaultPreferences,
      failed: false,
    })
  })

  it('reports a failure when storage access throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage is blocked')
      },
    })
    expect(readPreferences()).toEqual({
      value: defaultPreferences,
      failed: true,
    })
  })
})
