import { describe, expect, it } from 'bun:test'
import type { LibraryRow } from '../../bindings/loom/internal/service'
import {
  DEFAULT_ASSET_VIEWS,
  matchesAssetView,
  parseAssetViews,
  serializeAssetViews,
  sortAssetRows,
} from './asset-views'

const rows: LibraryRow[] = [
  {
    id: 1,
    fileName: 'zeta.png',
    filePath: 'zeta.png',
    thumbUrl: '',
    promptText: '',
    tags: [],
    placed: false,
    createdAt: '2026-01-01',
    archived: false,
    trashed: false,
    missing: false,
    groupId: 0,
    width: 0,
    height: 0,
  },
  {
    id: 2,
    fileName: 'alpha.png',
    filePath: 'alpha.png',
    thumbUrl: '',
    promptText: '',
    tags: [],
    placed: true,
    createdAt: '2026-01-02',
    archived: false,
    trashed: false,
    missing: false,
    groupId: 0,
    width: 0,
    height: 0,
  },
]

describe('asset views', () => {
  it('round-trips saved view definitions and rejects malformed settings', () => {
    expect(parseAssetViews(serializeAssetViews(DEFAULT_ASSET_VIEWS))).toEqual(
      DEFAULT_ASSET_VIEWS
    )
    expect(() => parseAssetViews('{"not":"views"}')).toThrow()
  })

  it('matches placement and sorts by name or recency', () => {
    const unplaced = DEFAULT_ASSET_VIEWS[1]
    expect(rows.filter((row) => matchesAssetView(row, unplaced))).toEqual([
      rows[0],
    ])
    expect(sortAssetRows(rows, 'name-asc').map((row) => row.fileName)).toEqual([
      'alpha.png',
      'zeta.png',
    ])
    expect(sortAssetRows(rows, 'recent').map((row) => row.id)).toEqual([2, 1])
  })
})
