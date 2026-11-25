import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CanvasData } from '../bindings/loom/internal/service/models'
import { legacyServiceCall } from './legacy-service'
import { legacyNames, seedLegacySet } from './legacy-set-fixture'
import { expect, test } from './test-fixtures'
import {
  asset,
  fixturePath,
  imageNodes,
  nodeBox,
  openAssetsShelf,
  openFixtureRepo,
  selectImageNodes,
} from './test-helpers'

test('persisted legacy sets open as individual images and relationships', async ({
  page,
}, testInfo) => {
  const repo = await fixturePath('group-fixtures')
  const dbPath = path.join(repo, '.loom', 'db.sqlite')
  await seedLegacySet(repo)
  const before = new DatabaseSync(dbPath, { readOnly: true })
  const rows = (db: DatabaseSync, sql: string) =>
    JSON.stringify(db.prepare(sql).all())
  const oldSets = rows(before, 'SELECT * FROM groups ORDER BY id')
  const oldHistory = rows(before, 'SELECT * FROM operation_log ORDER BY seq')
  const oldSettings = rows(
    before,
    "SELECT * FROM settings WHERE scope='repo' AND key IN ('undo_cursor', 'undo_history_floor') ORDER BY key"
  )
  const oldImages = rows(
    before,
    'SELECT id,file_path,prompt_id,width,height,file_size,content_hash,archived,trashed,canvas_x,canvas_y,created_at FROM images ORDER BY id'
  )
  const oldPrompts = rows(before, 'SELECT * FROM prompts ORDER BY id')
  const oldTags = rows(before, 'SELECT * FROM tags ORDER BY id')
  const oldImageTags = rows(
    before,
    'SELECT * FROM image_tags ORDER BY image_id,tag_id'
  )
  const oldRelationships = rows(
    before,
    'SELECT * FROM relationships ORDER BY pairing_order'
  )
  before.close()
  const mediaBefore = await Promise.all(
    legacyNames.map((name) => readFile(path.join(repo, name)))
  )

  await openFixtureRepo(page, 'group-fixtures')
  await expect(imageNodes(page)).toHaveCount(3)
  await expect(page.locator('.react-flow__node-group')).toHaveCount(0)
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  expect(
    (
      await page
        .locator('.react-flow__edge')
        .evaluateAll((edges) =>
          edges.map((edge) => edge.getAttribute('data-id'))
        )
    ).sort()
  ).toEqual(['10', '8'])
  await openAssetsShelf(page)
  for (const [index, name] of legacyNames.entries()) {
    await expect(asset(page, name)).toBeVisible()
    await expect(
      page.locator(`.react-flow__node-image[data-id="${index + 1}"]`)
    ).toBeVisible()
  }
  const load = () =>
    legacyServiceCall<CanvasData>(page, 'imageservice.ts', 'LoadCanvas', [repo])
  const canvas = await load()
  expect(canvas.groups ?? []).toEqual([])
  expect(
    canvas.relationships?.map((edge) => [
      edge.id,
      edge.sourceImageId,
      edge.derivedImageId,
    ])
  ).toEqual([
    [8, 1, 2],
    [10, 1, 3],
  ])
  for (const method of ['Undo', 'Redo']) {
    const result = await legacyServiceCall<{ applied: boolean }>(
      page,
      'undoservice.ts',
      method,
      [repo]
    )
    expect(result.applied).toBe(false)
  }
  const after = new DatabaseSync(dbPath, { readOnly: true })
  expect(rows(after, 'SELECT * FROM groups')).toBe('[]')
  expect(rows(after, 'SELECT id FROM images WHERE group_id IS NOT NULL')).toBe(
    '[]'
  )
  expect(rows(after, 'SELECT * FROM retired_sets ORDER BY id')).toBe(oldSets)
  expect(
    rows(
      after,
      'SELECT image_id,group_id FROM retired_set_members ORDER BY image_id'
    )
  ).toBe('[{"image_id":1,"group_id":11},{"image_id":2,"group_id":11}]')
  expect(rows(after, 'SELECT * FROM retired_operation_log ORDER BY seq')).toBe(
    oldHistory
  )
  expect(
    rows(after, 'SELECT * FROM retired_history_settings ORDER BY key')
  ).toBe(oldSettings)
  expect(
    rows(
      after,
      'SELECT id,file_path,prompt_id,width,height,file_size,content_hash,archived,trashed,canvas_x,canvas_y,created_at FROM images ORDER BY id'
    )
  ).toBe(oldImages)
  expect(rows(after, 'SELECT * FROM prompts ORDER BY id')).toBe(oldPrompts)
  expect(rows(after, 'SELECT * FROM tags ORDER BY id')).toBe(oldTags)
  expect(rows(after, 'SELECT * FROM image_tags ORDER BY image_id,tag_id')).toBe(
    oldImageTags
  )
  expect(
    rows(after, 'SELECT * FROM relationships ORDER BY pairing_order')
  ).toBe(oldRelationships)
  expect(rows(after, 'PRAGMA foreign_key_check')).toBe('[]')
  expect(rows(after, 'PRAGMA integrity_check')).toBe(
    '[{"integrity_check":"ok"}]'
  )
  after.close()
  expect(
    await Promise.all(
      legacyNames.map((name) => readFile(path.join(repo, name)))
    )
  ).toEqual(mediaBefore)

  await selectImageNodes(page, [0, 1])
  await expect(page.getByTestId('dock-create-set')).toHaveCount(0)
  await expect(page.getByTestId('dock-unplace')).toHaveCount(0)
  await imageNodes(page).first().click({ button: 'right' })
  await expect(
    page.getByRole('menu').getByRole('menuitem', { name: /set|group/i })
  ).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+g')
  await expect(imageNodes(page)).toHaveCount(3)
  await expect(page.locator('.react-flow__node-group')).toHaveCount(0)
  const source = await nodeBox(imageNodes(page).nth(2))
  const target = await nodeBox(imageNodes(page).first())
  await page.mouse.move(source.x + 30, source.y + 30)
  await page.mouse.down()
  await page.mouse.move(target.x + 30, target.y + 30, { steps: 8 })
  await expect(
    page.getByText('Release to add or move into this set')
  ).toHaveCount(0)
  await page.mouse.up()
  await expect(page.locator('.react-flow__node-group')).toHaveCount(0)
  await expect(imageNodes(page)).toHaveCount(3)
  await testInfo.attach('legacy-individual-images', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
  await page.reload()
  await expect(imageNodes(page)).toHaveCount(3)
  expect((await load()).relationships).toEqual(canvas.relationships)
  expect(
    await Promise.all(
      legacyNames.map((name) => readFile(path.join(repo, name)))
    )
  ).toEqual(mediaBefore)
})
