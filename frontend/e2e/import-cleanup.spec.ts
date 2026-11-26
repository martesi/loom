import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { legacyServiceCall } from './legacy-service'
import { expect, test } from './test-fixtures'
import {
  asset,
  fixturePath,
  openAssetsShelf,
  openFixtureRepo,
} from './test-helpers'

test('canvas reopens after purging an externally edited imported file', async ({
  page,
}) => {
  const repo = await fixturePath('group-fixtures')
  const sourceBytes = await readFile(
    await fixturePath('group-fixtures', 'group-alpha.png')
  )
  const changedBytes = Buffer.concat([
    sourceBytes,
    Buffer.from('external edit'),
  ])
  const fileName = 'externally-edited.png'

  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  const [imageID] = await legacyServiceCall<number[]>(
    page,
    'imageservice.ts',
    'ImportMedia',
    [
      repo,
      [{ name: fileName, data: sourceBytes.toString('base64') }],
      false,
      0,
      0,
    ]
  )
  expect(imageID).toBeGreaterThan(0)

  const visiblePath = path.join(repo, fileName)
  await writeFile(visiblePath, changedBytes)
  await legacyServiceCall<void>(page, 'imageservice.ts', 'PurgeImages', [
    repo,
    [imageID],
  ])

  const db = new DatabaseSync(path.join(repo, '.loom', 'db.sqlite'), {
    readOnly: true,
  })
  try {
    const cleanupRows = db
      .prepare('SELECT COUNT(*) AS count FROM import_cleanup_queue')
      .get() as { count: number }
    expect(cleanupRows.count).toBe(1)
  } finally {
    db.close()
  }
  expect(await readFile(visiblePath)).toEqual(changedBytes)

  await page.reload()
  await expect(page).toHaveURL(/\/canvas$/)
  await expect(page.getByRole('heading', { name: 'Canvas' })).toBeVisible()
  await expect(page.locator('.react-flow')).toBeVisible()
  await openAssetsShelf(page)
  await expect(asset(page, fileName)).toBeVisible()
  expect(await readFile(visiblePath)).toEqual(changedBytes)
})
