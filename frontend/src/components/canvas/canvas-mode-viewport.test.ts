import { expect, it } from 'bun:test'
import {
  readCanvasModeViewport,
  resolveCanvasModeViewports,
  writeCanvasModeViewport,
} from './canvas-mode-viewport'

function createStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }
}

it('persists View and Edit viewports independently for each repository', () => {
  const storage = createStorage()
  const view = { x: -120, y: -80, zoom: 1.5 }
  const edit = { x: 50, y: 90, zoom: 0.75 }
  writeCanvasModeViewport('/repo/a', 'view', view, storage)
  writeCanvasModeViewport('/repo/a', 'edit', edit, storage)
  writeCanvasModeViewport('/repo/b', 'view', { x: 1, y: 2, zoom: 1 }, storage)
  expect(readCanvasModeViewport('/repo/a', 'view', storage)).toEqual(view)
  expect(readCanvasModeViewport('/repo/a', 'edit', storage)).toEqual(edit)
  expect(readCanvasModeViewport('/repo/b', 'view', storage)).toEqual({
    x: 1,
    y: 2,
    zoom: 1,
  })
  expect(readCanvasModeViewport('/repo/b', 'edit', storage)).toBeNull()
})

it('ignores invalid stored viewport data', () => {
  const storage = createStorage()
  storage.setItem(
    'loom.canvas.viewport.v1:%2Frepo:view',
    '{"x":0,"y":0,"zoom":0}'
  )
  expect(readCanvasModeViewport('/repo', 'view', storage)).toBeNull()
})

it('falls back each missing mode to the repository viewport independently', () => {
  const repository = { x: -300, y: 125, zoom: 1.4 }
  const view = { x: -90, y: 30, zoom: 2 }
  const edit = { x: 40, y: -75, zoom: 0.8 }

  expect(resolveCanvasModeViewports(repository, null, null)).toEqual({
    view: repository,
    edit: repository,
  })
  expect(resolveCanvasModeViewports(repository, view, null)).toEqual({
    view,
    edit: repository,
  })
  expect(resolveCanvasModeViewports(repository, null, edit)).toEqual({
    view: repository,
    edit,
  })
  expect(resolveCanvasModeViewports(repository, view, edit)).toEqual({
    view,
    edit,
  })
})
