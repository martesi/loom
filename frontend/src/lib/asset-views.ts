import type { LibraryRow } from '../../bindings/loom/internal/service'

export type AssetLayout = 'list' | 'gallery'
export type AssetSort = 'recent' | 'oldest' | 'name-asc' | 'name-desc'
export type AssetStatus = 'active' | 'all' | 'archived' | 'trashed' | 'missing'

export interface AssetView {
  id: string
  name: string
  search: string
  status: AssetStatus
  pairing: '' | 'paired' | 'unpaired'
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
    pairing: '',
    tagId: 0,
    sort: 'recent',
    layout: 'list',
  },
  {
    id: 'default-unpaired',
    name: 'Unpaired',
    search: '',
    status: 'active',
    pairing: 'unpaired',
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
  if (!Array.isArray(value)) throw new InvalidAssetViewsError()
  // Older saved views filtered on canvas coordinates. Those coordinates do
  // not describe whether an asset has a relationship, so retain the view but
  // clear that obsolete filter instead of applying the wrong meaning.
  return value.map((item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const legacy = item as Record<string, unknown>
      if (!('pairing' in legacy) && 'placement' in legacy) {
        const { placement: _placement, ...view } = legacy
        const migrated = { ...view, pairing: '' }
        if (isAssetView(migrated)) return migrated
      }
    }
    if (isAssetView(item)) return item
    throw new InvalidAssetViewsError()
  })
}

export function matchesAssetView(row: LibraryRow, view: AssetView) {
  if (view.status === 'missing' && !row.missing) return false
  if (view.status === 'archived' && (!row.archived || row.trashed)) return false
  if (view.status === 'trashed' && !row.trashed) return false
  if (view.status === 'active' && (row.archived || row.trashed)) return false
  if (view.pairing === 'paired' && !row.paired) return false
  if (view.pairing === 'unpaired' && row.paired) return false
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
    typeof view.pairing !== 'string' ||
    typeof view.sort !== 'string' ||
    typeof view.layout !== 'string'
  )
    return false

  return (
    ['active', 'all', 'archived', 'trashed', 'missing'].includes(view.status) &&
    ['', 'paired', 'unpaired'].includes(view.pairing) &&
    Number.isSafeInteger(view.tagId) &&
    ['recent', 'oldest', 'name-asc', 'name-desc'].includes(view.sort) &&
    ['list', 'gallery'].includes(view.layout)
  )
}
