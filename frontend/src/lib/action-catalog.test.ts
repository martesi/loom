import { describe, expect, it } from 'bun:test'
import {
  actionEligibility,
  type CanvasAction,
  fuzzyMatch,
  normalizeShortcut,
  searchActions,
  shortcutMatches,
} from './action-catalog'

describe('action catalog helpers', () => {
  it('normalizes platform modifier aliases and modifier order', () => {
    expect(normalizeShortcut('Shift+ControlOrMeta+C')).toBe('mod+shift+c')
    expect(normalizeShortcut('Command+K')).toBe('mod+k')
  })

  it('matches digit shortcuts by physical key and ? by its produced character', () => {
    const digit = {
      code: 'Digit1',
      key: '!',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    }
    const question = {
      code: 'Slash',
      key: '?',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    }
    expect(shortcutMatches(digit, 'Shift+1')).toBe(true)
    expect(shortcutMatches(question, '?')).toBe(true)
  })

  it('matches symbol shortcuts with modifiers by produced character', () => {
    const zoomOut = {
      code: 'Minus',
      key: '-',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }
    const zoomIn = {
      code: 'Equal',
      key: '=',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }
    expect(shortcutMatches(zoomOut, 'Mod+-')).toBe(true)
    expect(shortcutMatches(zoomIn, 'Mod+=')).toBe(true)
  })

  it('fuzzy matches word starts and consecutive characters with ranges', () => {
    const match = fuzzyMatch('fa', 'Fit all')
    expect(match).not.toBeNull()
    expect(match?.positions).toEqual([0, 4])
    expect(fuzzyMatch('zz', 'Fit all')).toBeNull()
  })

  it('searches labels, categories, aliases, and keeps disabled actions visible', () => {
    const actions: CanvasAction[] = [
      {
        id: 'fit-all',
        label: 'Fit all',
        description: 'Show every placed item',
        category: 'Canvas view',
        aliases: ['zoom extents'],
        context: 'Canvas',
        enabled: true,
        execute: () => {},
      },
      {
        id: 'fit-selection',
        label: 'Fit selection',
        description: 'Center selected items',
        category: 'Canvas view',
        aliases: ['selection bounds'],
        context: 'Canvas',
        enabled: false,
        disabledReason: 'Select a Canvas item',
        execute: () => {},
      },
    ]
    expect(
      searchActions(actions, 'zoom extents').map(({ action }) => action.id)
    ).toEqual(['fit-all'])
    expect(searchActions(actions, 'canvas view')).toHaveLength(2)
    expect(actionEligibility(false).disabledReason).toBe(
      'Unavailable right now'
    )
  })
})
