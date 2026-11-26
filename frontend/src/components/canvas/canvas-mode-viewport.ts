import type { Viewport } from '@xyflow/react'

const KEY_PREFIX = 'loom.canvas.viewport.v1'
type ViewportStorage = Pick<Storage, 'getItem' | 'setItem'>

export function readCanvasModeViewport(
  repoPath: string,
  mode: 'view' | 'edit',
  storage: ViewportStorage | undefined = browserStorage()
): Viewport | null {
  if (!storage) return null
  const serialized = storage.getItem(key(repoPath, mode))
  if (!serialized) return null
  const value: unknown = JSON.parse(serialized)
  if (!isViewport(value)) return null
  return value
}

export function writeCanvasModeViewport(
  repoPath: string,
  mode: 'view' | 'edit',
  viewport: Viewport,
  storage: ViewportStorage | undefined = browserStorage()
) {
  if (!storage) return
  storage.setItem(key(repoPath, mode), JSON.stringify(viewport))
}

function browserStorage(): ViewportStorage | undefined {
  if (typeof window === 'undefined') return undefined
  return window.localStorage
}

function key(repoPath: string, mode: 'view' | 'edit') {
  return `${KEY_PREFIX}:${encodeURIComponent(repoPath)}:${mode}`
}

function isViewport(value: unknown): value is Viewport {
  if (!value || typeof value !== 'object') return false
  const viewport = value as Record<string, unknown>
  return (
    typeof viewport.x === 'number' &&
    Number.isFinite(viewport.x) &&
    typeof viewport.y === 'number' &&
    Number.isFinite(viewport.y) &&
    typeof viewport.zoom === 'number' &&
    Number.isFinite(viewport.zoom) &&
    viewport.zoom > 0
  )
}
