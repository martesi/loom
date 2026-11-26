import { describe, expect, it } from 'bun:test'
import {
  allowsCanvasAction,
  allowsCanvasCapability,
  type CanvasCapability,
  type CanvasInternalMode,
} from './canvas-mode-policy'

describe('internal Canvas capability policy', () => {
  const capabilities: CanvasCapability[] = [
    'navigate',
    'select',
    'copy',
    'history',
    'relationship',
    'geometry',
    'canvas-drop',
  ]
  for (const mode of ['legacy', 'view', 'edit'] as CanvasInternalMode[]) {
    it(`${mode} applies its capability matrix`, () => {
      for (const capability of capabilities) {
        const deniedInView = [
          'relationship',
          'geometry',
          'canvas-drop',
        ].includes(capability)
        expect(allowsCanvasCapability(mode, capability)).toBe(
          mode !== 'view' || !deniedInView
        )
      }
    })
  }
  it('blocks relationship and geometry actions but permits navigation and history', () => {
    for (const id of [
      'auto-arrange-active',
      'auto-arrange-selection',
      'align-horizontal',
      'align-vertical',
      'remove-selected-relationships',
      'reverse-relationship',
      'remove-relationship',
      'connect-derivative',
      'connect-source',
      'reverse-relationship-tool',
    ]) {
      expect(allowsCanvasAction('view', id)).toBe(false)
      expect(allowsCanvasAction('edit', id)).toBe(true)
      expect(allowsCanvasAction('legacy', id)).toBe(true)
    }
    for (const id of [
      'undo',
      'redo',
      'fit-all',
      'preview-selection',
      'copy-original',
    ])
      expect(allowsCanvasAction('view', id)).toBe(true)
  })
})
