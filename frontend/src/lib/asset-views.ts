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

export function parseAssetViews(serialized: string): AssetView[] {
  const value: unknown = JSON.parse(serialized)
  if (!Array.isArray(value) || !value.every(isAssetView)) {
    throw new Error('Saved asset views have an invalid format')
  }
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
  if (!value || typeof value !== 'object') return false
  const view = value as Record<string, unknown>
  return (
    typeof view.id === 'string' &&
    typeof view.name === 'string' &&
    typeof view.search === 'string' &&
    ['active', 'all', 'archived', 'trashed', 'missing'].includes(
      String(view.status)
    ) &&
    ['', 'placed', 'unplaced'].includes(String(view.placement)) &&
    Number.isSafeInteger(view.tagId) &&
    ['recent', 'oldest', 'name-asc', 'name-desc'].includes(String(view.sort)) &&
    ['list', 'gallery'].includes(String(view.layout))
  )
}
