import type { LibraryRow } from '../../bindings/loom/internal/service'

export type AssetLayout = 'list' | 'gallery'
export type AssetSort = 'recent' | 'oldest' | 'name-asc' | 'name-desc'
export type AssetStatus = 'active' | 'all' | 'archived' | 'trashed' | 'missing'

export interface AssetView {
  id: string
  name: string
  search: string
  status: AssetStatus
  placement: '' | 'placed' | 'unplaced'
  tagId: number
  sort: AssetSort
  layout: AssetLayout
}

export const DEFAULT_ASSET_VIEWS: AssetView[] = [
  {
    id: 'default-recent',
    name: 'Recent',
    search: '',
    status: 'active',
    placement: '',
    tagId: 0,
    sort: 'recent',
    layout: 'list',
  },
  {
    id: 'default-unplaced',
    name: 'Unplaced',
    search: '',
    status: 'active',
    placement: 'unplaced',
    tagId: 0,
    sort: 'recent',
    layout: 'gallery',
  },
]

export function serializeAssetViews(views: AssetView[]) {
  return JSON.stringify(views)
}

export class InvalidAssetViewsError extends Error {
  constructor() {
    super()
    this.name = 'InvalidAssetViewsError'
  }
}

export function parseAssetViews(serialized: string): AssetView[] {
  let value: unknown
  // JSON.parse only reports syntax failures by throwing an untyped SyntaxError.
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new InvalidAssetViewsError()
  }
  if (!Array.isArray(value) || !value.every(isAssetView))
    throw new InvalidAssetViewsError()
  return value
}

export function matchesAssetView(row: LibraryRow, view: AssetView) {
  if (view.status === 'missing' && !row.missing) return false
  if (view.status === 'archived' && (!row.archived || row.trashed)) return false
  if (view.status === 'trashed' && !row.trashed) return false
  if (view.status === 'active' && (row.archived || row.trashed)) return false
  if (view.placement === 'placed' && !row.placed) return false
  if (view.placement === 'unplaced' && row.placed) return false
  return true
}

export function sortAssetRows(rows: LibraryRow[], sort: AssetSort) {
  return [...rows].sort((left, right) => {
    if (sort === 'name-asc' || sort === 'name-desc') {
      const order = left.fileName.localeCompare(right.fileName)
      return sort === 'name-asc' ? order : -order
    }
    const order = left.createdAt.localeCompare(right.createdAt)
    return sort === 'oldest' ? order : -order
  })
}

function isAssetView(value: unknown): value is AssetView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const view = value as Record<string, unknown>
  if (
    typeof view.id !== 'string' ||
    typeof view.name !== 'string' ||
    typeof view.search !== 'string' ||
    typeof view.status !== 'string' ||
    typeof view.placement !== 'string' ||
    typeof view.sort !== 'string' ||
    typeof view.layout !== 'string'
  )
    return false

  return (
    ['active', 'all', 'archived', 'trashed', 'missing'].includes(view.status) &&
    ['', 'placed', 'unplaced'].includes(view.placement) &&
    Number.isSafeInteger(view.tagId) &&
    ['recent', 'oldest', 'name-asc', 'name-desc'].includes(view.sort) &&
    ['list', 'gallery'].includes(view.layout)
  )
}
