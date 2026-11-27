import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runtimeMethodID } from './bindings'
import { legacyServiceCall } from './legacy-service'
import { expect, test } from './test-fixtures'
import {
  asset,
  assets,
  dropAsset,
  enterEdit,
  fixturePath,
  imageNodes,
  openAssetsShelf,
  openFixtureRepo,
} from './test-helpers'

const fixturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

test('library selection, search, relationship filters, and folder navigation', async ({
  page,
}) => {
  await openFixtureRepo(page, 'library-fixtures')
  await expect(assets(page)).toHaveCount(4)
  await expect(page.getByText('4 assets', { exact: true })).toBeVisible()
  const filters = page.getByRole('button', { name: /^Filters/ })
  await expect(filters).toHaveAttribute('aria-expanded', 'false')

  await page
    .getByRole('textbox', { name: 'Search assets' })
    .fill('folder-gamma')
  await expect(assets(page)).toHaveCount(1)
  await expect(asset(page, 'folder-gamma.png')).toBeVisible()
  await page.getByRole('textbox', { name: 'Search assets' }).fill('')

  await asset(page, 'root-alpha.png').click()
  await asset(page, 'root-beta.png').click({ modifiers: ['Shift'] })
  await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(2)

  await page.keyboard.press('Control+a')
  await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(4)

  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 500, y: 400 } })
  const ids = await assets(page).evaluateAll((rows) =>
    rows.map((row) => Number(row.getAttribute('data-asset-id')))
  )
  expect(ids).toHaveLength(4)
  await enterEdit(page)
  // Seed one relationship, independently of canvas position, to prove these
  // filters use graph relationships rather than placement flags.
  const db = new DatabaseSync(
    `${await fixturePath('library-fixtures')}/.loom/db.sqlite`
  )
  db.prepare(
    'INSERT OR IGNORE INTO relationships(source_image_id,derived_image_id) VALUES (?, ?)'
  ).run(ids[0], ids[1])
  db.close()
  await page.reload()
  await expect(page.getByTestId('canvas-mode-edit')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(imageNodes(page)).toHaveCount(4)
  await dropAsset(page, 'root-alpha.png', { x: 100, y: 100 })
  await expect(
    imageNodes(page).filter({ hasText: 'root-alpha.png' })
  ).toHaveClass(/selected/)
  await openAssetsShelf(page)
  await filters.click()
  await page
    .getByRole('combobox', { name: 'Relationship' })
    .selectOption('paired')
  await expect(assets(page)).toHaveCount(2)
  await expect(asset(page, 'root-alpha.png')).toBeVisible()
  await expect(asset(page, 'root-beta.png')).toBeVisible()

  await page
    .getByRole('combobox', { name: 'Relationship' })
    .selectOption('unpaired')
  await expect(assets(page)).toHaveCount(2)
  await expect(asset(page, 'root-alpha.png')).toHaveCount(0)
  await expect(asset(page, 'root-beta.png')).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Relationship' }).selectOption('')

  await page.getByRole('button', { name: 'Folders', exact: true }).click()
  await expect(page.getByRole('button', { name: /nested/ })).toBeVisible()
  await page.getByRole('button', { name: /nested/ }).click()
  await expect(asset(page, 'folder-gamma.png')).toBeVisible()
  await expect(asset(page, 'root-alpha.png')).toHaveCount(0)

  await asset(page, 'folder-gamma.png').dragTo(
    page.getByRole('button', { name: /deeper/ })
  )
  await expect(asset(page, 'folder-gamma.png')).toHaveCount(0)

  await page.getByRole('button', { name: /deeper/ }).click()
  await expect(asset(page, 'folder-delta.png')).toBeVisible()
  await expect(asset(page, 'folder-gamma.png')).toBeVisible()

  await asset(page, 'folder-gamma.png').click({ button: 'right' })
  await page.getByRole('menu').getByRole('button', { name: 'Rename…' }).click()
  await page
    .getByRole('menu')
    .getByLabel('Rename file')
    .fill('renamed-gamma.png')
  await page
    .getByRole('menu')
    .getByRole('button', { name: 'Rename', exact: true })
    .click()
  await expect(asset(page, 'renamed-gamma.png')).toBeVisible()
  await expect(asset(page, 'folder-gamma.png')).toHaveCount(0)

  await page.getByRole('button', { name: 'Repository', exact: true }).click()
  // Repository shows only root-level assets; the renamed file remains nested.
  await expect(asset(page, 'renamed-gamma.png')).toHaveCount(0)
  await page.getByRole('button', { name: /nested/ }).click()
  await page.getByRole('button', { name: /deeper/ }).click()
  await expect(asset(page, 'renamed-gamma.png')).toBeVisible()
})

test('paired filtering keeps relationships for trashed assets and after restore', async ({
  page,
}) => {
  await openFixtureRepo(page, 'library-fixtures')
  await enterEdit(page)
  const ids = await assets(page).evaluateAll((rows) =>
    rows.map((row) => Number(row.getAttribute('data-asset-id')))
  )
  const db = new DatabaseSync(
    `${await fixturePath('library-fixtures')}/.loom/db.sqlite`
  )
  db.prepare(
    'INSERT OR IGNORE INTO relationships(source_image_id,derived_image_id) VALUES (?, ?)'
  ).run(ids[0], ids[1])
  db.close()
  await page.reload()
  await openAssetsShelf(page)

  await page.getByRole('button', { name: /^Filters/ }).click()
  const relationship = page.getByRole('combobox', { name: 'Relationship' })
  const state = page.getByRole('combobox', { name: 'Asset state' })
  await relationship.selectOption('paired')
  await expect(assets(page)).toHaveCount(2)
  await relationship.selectOption('')

  await asset(page, 'root-beta.png').click()
  await page.getByTestId('toggle-inspector-shelf').click()
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await expect(inspector).toBeVisible()
  await inspector.getByRole('button', { name: 'Move to trash' }).click()
  const trashDialog = page.getByRole('dialog', {
    name: 'Move 1 asset to trash?',
  })
  await trashDialog.getByRole('button', { name: 'Move to trash' }).click()

  await state.selectOption('all')
  await relationship.selectOption('paired')
  await expect(assets(page)).toHaveCount(2)
  await expect(asset(page, 'root-alpha.png')).toBeVisible()
  await expect(asset(page, 'root-beta.png')).toBeVisible()

  await state.selectOption('trashed')
  await expect(assets(page)).toHaveCount(1)
  await expect(asset(page, 'root-beta.png')).toBeVisible()
  await relationship.selectOption('unpaired')
  await expect(assets(page)).toHaveCount(0)

  await relationship.selectOption('paired')
  await asset(page, 'root-beta.png').click()
  await page.getByRole('button', { name: 'Restore from trash' }).click()
  await state.selectOption('active')
  await expect(assets(page)).toHaveCount(2)
  await expect(asset(page, 'root-alpha.png')).toBeVisible()
  await expect(asset(page, 'root-beta.png')).toBeVisible()
})

test('batch trash and restore use one undoable operation each', async ({
  page,
}) => {
  await openFixtureRepo(page, 'library-fixtures')
  await openAssetsShelf(page)
  const repo = await fixturePath('library-fixtures')
  const dbPath = `${repo}/.loom/db.sqlite`
  const db = new DatabaseSync(dbPath)
  const operationCount = () =>
    (
      db.prepare('SELECT COUNT(*) AS count FROM operation_log').get() as {
        count: number
      }
    ).count
  const imageIDs = await Promise.all(
    ['root-alpha.png', 'root-beta.png'].map(async (fileName) =>
      Number(await asset(page, fileName).getAttribute('data-asset-id'))
    )
  )
  expect(imageIDs).toHaveLength(2)
  const initialOperations = operationCount()
  const trashMethodID = runtimeMethodID('imageservice.ts', 'TrashImages')
  const restoreMethodID = runtimeMethodID('imageservice.ts', 'RestoreImages')
  let trashRequests = 0
  let restoreRequests = 0
  page.on('request', (request) => {
    if (!request.url().endsWith('/wails/runtime')) return
    const body = request.postData() ?? ''
    if (body.includes(`"methodID":${trashMethodID}`)) trashRequests++
    if (body.includes(`"methodID":${restoreMethodID}`)) restoreRequests++
  })

  await asset(page, 'root-alpha.png').click()
  await asset(page, 'root-beta.png').click({ modifiers: ['Shift'] })
  await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(2)
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  if ((await inspector.getAttribute('data-visible')) !== 'true') {
    await page.getByTestId('toggle-inspector-shelf').click()
  }
  await inspector.getByRole('button', { name: 'Move to trash' }).click()
  const trashDialog = page.getByRole('dialog', {
    name: 'Move 2 assets to trash?',
  })
  await trashDialog.getByRole('button', { name: 'Move to trash' }).click()
  await expect(asset(page, 'root-alpha.png')).toHaveCount(0)
  await expect(asset(page, 'root-beta.png')).toHaveCount(0)
  expect(trashRequests).toBe(1)
  expect(operationCount()).toBe(initialOperations + 1)
  const trashedPaths = db
    .prepare(
      'SELECT file_path FROM images WHERE id IN (?, ?) AND trashed = 1 ORDER BY id'
    )
    .all(...imageIDs) as { file_path: string }[]
  expect(trashedPaths).toHaveLength(2)
  expect(
    trashedPaths.every((row) => row.file_path.includes('/.loom/trash/'))
  ).toBe(true)

  const undo = await legacyServiceCall<{ applied: boolean }>(
    page,
    'undoservice.ts',
    'Undo',
    [repo]
  )
  expect(undo.applied).toBe(true)
  const undone = db
    .prepare(
      'SELECT COUNT(*) AS count FROM images WHERE id IN (?, ?) AND trashed = 0'
    )
    .get(...imageIDs) as { count: number }
  expect(undone.count).toBe(2)
  const redo = await legacyServiceCall<{ applied: boolean }>(
    page,
    'undoservice.ts',
    'Redo',
    [repo]
  )
  expect(redo.applied).toBe(true)

  await page.reload()
  await openAssetsShelf(page)
  await page.getByRole('button', { name: /^Filters/ }).click()
  await page
    .getByRole('combobox', { name: 'Asset state' })
    .selectOption('trashed')
  await asset(page, 'root-alpha.png').click()
  await asset(page, 'root-beta.png').click({ modifiers: ['Shift'] })
  await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(2)
  const inspectorToggle = page.getByTestId('toggle-inspector-shelf')
  if ((await inspectorToggle.getAttribute('aria-pressed')) !== 'true') {
    await inspectorToggle.click()
  }
  await inspector.getByRole('button', { name: 'Restore from trash' }).click()
  await expect(asset(page, 'root-alpha.png')).toHaveCount(0)
  expect(restoreRequests).toBe(1)
  expect(operationCount()).toBe(initialOperations + 2)
  const active = db
    .prepare(
      'SELECT COUNT(*) AS count FROM images WHERE id IN (?, ?) AND trashed = 0'
    )
    .get(...imageIDs) as { count: number }
  expect(active.count).toBe(2)
  db.close()
})

test('failed batch trash keeps every file and history entry unchanged', async ({
  page,
}) => {
  await openFixtureRepo(page, 'library-fixtures')
  await openAssetsShelf(page)
  const repo = await fixturePath('library-fixtures')
  const dbPath = path.join(repo, '.loom', 'db.sqlite')
  const fileNames = ['root-alpha.png', 'root-beta.png']
  const imageIDs = await Promise.all(
    fileNames.map(async (fileName) =>
      Number(await asset(page, fileName).getAttribute('data-asset-id'))
    )
  )
  const filePaths = fileNames.map((fileName) => path.join(repo, fileName))
  const fileBytes = await Promise.all(
    filePaths.map((filePath) => readFile(filePath))
  )
  const db = new DatabaseSync(dbPath)
  const historyBefore = JSON.stringify(
    db
      .prepare(
        'SELECT seq, kind, forward, inverse, created_at FROM operation_log ORDER BY seq'
      )
      .all()
  )
  const secondID = Math.max(...imageIDs)
  db.exec(
    `CREATE TRIGGER reject_batch_trash BEFORE UPDATE OF trashed ON images WHEN OLD.id = ${secondID} AND NEW.trashed = 1 BEGIN SELECT RAISE(ABORT, 'injected batch trash failure'); END`
  )
  db.close()

  await asset(page, fileNames[0]).click()
  await asset(page, fileNames[1]).click({ modifiers: ['Shift'] })
  const inspectorToggle = page.getByTestId('toggle-inspector-shelf')
  if ((await inspectorToggle.getAttribute('aria-pressed')) !== 'true') {
    await inspectorToggle.click()
  }
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await inspector.getByRole('button', { name: 'Move to trash' }).click()
  const dialog = page.getByRole('dialog', { name: 'Move 2 assets to trash?' })
  await dialog.getByRole('button', { name: 'Move to trash' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'injected batch trash failure'
  )

  const after = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = after
      .prepare(
        'SELECT file_path, trashed FROM images WHERE id IN (?, ?) ORDER BY id'
      )
      .all(...imageIDs) as { file_path: string; trashed: number }[]
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.trashed)).toEqual([0, 0])
    expect(rows.map((row) => row.file_path)).toEqual(filePaths)
    const historyAfter = JSON.stringify(
      after
        .prepare(
          'SELECT seq, kind, forward, inverse, created_at FROM operation_log ORDER BY seq'
        )
        .all()
    )
    expect(historyAfter).toBe(historyBefore)
  } finally {
    after.close()
  }
  expect(
    await Promise.all(filePaths.map((filePath) => readFile(filePath)))
  ).toEqual(fileBytes)
})

test('Assets gallery controls and saved views persist and switch from the palette', async ({
  page,
}) => {
  await openFixtureRepo(page, 'inspector-fixtures')
  await asset(page, 'inspect-alpha.png').click()
  const inspector = page.getByLabel('Inspector')
  await inspector.getByLabel('Add tag').fill('portrait')
  await inspector
    .getByRole('button', { name: 'Add to selected assets', exact: true })
    .click()
  await inspector.getByLabel('Prompt').fill('soft studio light')
  await inspector.getByRole('button', { name: 'Save prompt' }).click()

  await page.getByRole('button', { name: 'Gallery view' }).click()
  const gallery = page.getByRole('grid', { name: 'Asset gallery' })
  await expect(gallery.getByRole('gridcell')).toHaveCount(2)
  await expect(
    gallery.getByRole('button', { name: /inspect-alpha.png/ })
  ).toBeVisible()
  const firstCard = gallery.getByRole('button').nth(0)
  const secondCard = gallery.getByRole('button').nth(1)
  const firstBox = await firstCard.boundingBox()
  const secondBox = await secondCard.boundingBox()
  if (!firstBox || !secondBox)
    throw new Error('Gallery cards have no layout box')
  const dx = secondBox.x - firstBox.x
  const dy = secondBox.y - firstBox.y
  const rowKey =
    Math.abs(dx) > Math.abs(dy)
      ? dx > 0
        ? 'ArrowRight'
        : 'ArrowLeft'
      : dy > 0
        ? 'ArrowDown'
        : 'ArrowUp'
  const reverseRowKey = {
    ArrowRight: 'ArrowLeft',
    ArrowLeft: 'ArrowRight',
    ArrowDown: 'ArrowUp',
    ArrowUp: 'ArrowDown',
  }[rowKey]
  await firstCard.focus()
  await page.keyboard.press(rowKey)
  await expect(secondCard).toBeFocused()
  await page.keyboard.press(reverseRowKey)
  await expect(firstCard).toBeFocused()
  await page.mouse.move(0, 0)
  await page.getByRole('button', { name: 'Gallery view' }).hover()
  await expect(page.getByTestId('base-tooltip-popup')).toContainText(
    'Gallery view'
  )
  await expect(page.getByText('Size 2')).toBeVisible()
  await page.getByRole('button', { name: 'Larger gallery cards' }).click()
  await expect(page.getByText('Size 3')).toBeVisible()
  await page.getByLabel('Image fit').selectOption('contain')
  await page.getByLabel('Tags').check()
  await page.getByRole('checkbox', { name: 'Prompt' }).check()
  await expect(gallery.getByText('portrait')).toBeVisible()
  await expect(gallery.getByText('soft studio light')).toBeVisible()
  await expect(gallery.getByText('1 × 1').first()).toBeVisible()
  await gallery
    .getByRole('button', { name: /inspect-alpha.png/ })
    .click({ button: 'right' })
  await expect(
    page.getByRole('menu').getByRole('button', { name: 'Compress…' })
  ).toBeVisible()
  await expect(
    page.getByRole('menu').getByRole('menuitem', { name: 'Show commands' })
  ).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: /^Filters/ }).click()
  await page.getByRole('combobox', { name: 'Tag filter' }).selectOption({
    label: 'portrait',
  })
  await page.getByLabel('Saved view name').fill('Portrait references')
  await page.getByRole('button', { name: 'Save view' }).click()
  const savedViews = page.getByRole('combobox', { name: 'Saved asset view' })
  await expect(
    savedViews.getByRole('option', { name: 'Portrait references' })
  ).toHaveCount(1)
  await expect(savedViews.getByRole('option', { name: 'Recent' })).toHaveCount(
    1
  )
  await expect(
    savedViews.getByRole('option', { name: 'Unpaired' })
  ).toHaveCount(1)
  await page.getByRole('button', { name: 'List view' }).click()
  await page.getByLabel('Sort assets').selectOption('name-asc')
  await expect(page.getByLabel('Saved view name')).toHaveValue(
    'Portrait references'
  )
  await page.getByLabel('Saved view name').fill('Portraits')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(
    savedViews.getByRole('option', { name: 'Portraits' })
  ).toHaveCount(1)
  await expect(page.getByRole('status')).toContainText('View saved')

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Canvas' })).toBeVisible()
  await openAssetsShelf(page)
  const restoredViews = page.getByRole('combobox', { name: 'Saved asset view' })
  await expect(
    restoredViews.getByRole('option', { name: 'Portraits' })
  ).toHaveCount(1)
  await restoredViews.selectOption({ label: 'Portraits' })
  await expect(page.getByRole('button', { name: 'List view' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.getByLabel('Sort assets')).toHaveValue('name-asc')
  await expect(
    page.getByRole('listbox', { name: 'Assets' }).getByRole('option')
  ).toHaveCount(1)

  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 500, y: 400 } })
  await page.keyboard.press('ControlOrMeta+k')
  const search = page.getByRole('combobox', { name: 'Search commands' })
  await search.fill('Show Assets gallery')
  const galleryCommand = page.getByRole('option', {
    name: /Show Assets gallery/,
  })
  await expect(galleryCommand.locator('kbd')).toHaveCount(3)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('grid', { name: 'Asset gallery' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Gallery view' })
  ).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: 'Delete saved view' }).click()
  await expect(
    restoredViews.getByRole('option', { name: 'Portraits' })
  ).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('View saved')
})

test('gallery vertical navigation moves between rows with unequal card heights', async ({
  page,
}) => {
  await openFixtureRepo(page, 'gallery-keyboard-fixtures')
  await page.getByRole('button', { name: 'Gallery view' }).click()
  await page.getByRole('button', { name: 'Smaller gallery cards' }).click()

  const gallery = page.getByRole('grid', { name: 'Asset gallery' })
  const firstRow = gallery.getByRole('row').first()
  const firstCard = firstRow.getByRole('button').first()
  await firstCard.click()

  const inspector = page.getByLabel('Inspector')
  await inspector.getByLabel('Add tag').fill('keyboard-height')
  await inspector
    .getByRole('button', { name: 'Add to selected assets', exact: true })
    .click()
  await inspector
    .getByLabel('Prompt')
    .fill('A prompt that adds height to this card')
  await inspector.getByRole('button', { name: 'Save prompt' }).click()

  await page.getByRole('checkbox', { name: 'Tags' }).check()
  await page.getByRole('checkbox', { name: 'Prompt' }).check()
  await expect(gallery.getByRole('row').nth(1)).toBeVisible()
  const firstRowCards = firstRow.getByRole('button')
  expect(await firstRowCards.count()).toBeGreaterThan(1)
  const heights = await firstRowCards.evaluateAll((cards) =>
    cards.map((card) => card.getBoundingClientRect().height)
  )
  expect(Math.max(...heights)).toBeGreaterThan(Math.min(...heights))

  const shortestIndex = heights.indexOf(Math.min(...heights))
  await firstRowCards.nth(shortestIndex).focus()
  await page.keyboard.press('ArrowDown')
  await expect(
    gallery.getByRole('row').nth(1).locator('[data-gallery-card]:focus')
  ).toHaveCount(1)
})

test('asset selection survives view switches and multi-row drag transfers selection to Canvas', async ({
  page,
}) => {
  await openFixtureRepo(page, 'library-selection-fixtures')
  await enterEdit(page)
  const list = page.getByRole('listbox', { name: 'Assets' })
  const selectedAssets = list.locator('[role=option][aria-selected=true]')

  await expect(list.getByRole('checkbox')).toHaveCount(0)
  await asset(page, 'root-alpha.png').click()
  await asset(page, 'root-beta.png').click({ modifiers: ['Control'] })
  await expect(selectedAssets).toHaveCount(2)
  await expect(
    page.getByText('2 assets selected', { exact: true })
  ).toBeVisible()

  await page.getByRole('button', { name: 'Folders', exact: true }).click()
  await expect(selectedAssets).toHaveCount(2)
  await page.getByRole('button', { name: 'All Assets', exact: true }).click()
  await expect(selectedAssets).toHaveCount(2)

  await asset(page, 'root-alpha.png').dragTo(
    page.locator('.react-flow__pane'),
    {
      targetPosition: { x: 500, y: 160 },
    }
  )
  await expect(imageNodes(page)).toHaveCount(4)
  await expect(selectedAssets).toHaveCount(0)
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)

  await dropAsset(page, 'root-alpha.png', { x: 480, y: 220 })
  await expect(imageNodes(page)).toHaveCount(4)
})

test('inspector edits metadata and library filters follow tag/archive/trash state', async ({
  page,
}) => {
  await openFixtureRepo(page, 'inspector-fixtures')
  await asset(page, 'inspect-alpha.png').click()
  await expect(
    page.getByLabel('Inspector').getByText('inspect-alpha.png', { exact: true })
  ).toBeVisible()
  const inspector = page.getByLabel('Inspector')
  await page.getByRole('button', { name: /^Filters/ }).click()

  await inspector.getByLabel('Add tag').fill('portrait')
  await inspector
    .getByRole('button', { name: 'Add to selected assets', exact: true })
    .click()
  await expect(inspector.getByLabel('Tag summary')).toContainText(
    'portrait — All selected assets'
  )

  await inspector.getByLabel('Prompt').fill('soft studio light')
  await inspector.getByRole('button', { name: 'Save prompt' }).click()
  await expect(inspector.getByLabel('Prompt')).toHaveValue('soft studio light')

  await inspector.getByLabel('File path').fill('renamed-alpha.png')
  await inspector
    .getByRole('button', { name: 'Move or rename', exact: true })
    .click()
  await expect(asset(page, 'renamed-alpha.png')).toBeVisible()
  await expect(asset(page, 'inspect-alpha.png')).toHaveCount(0)

  await page.getByRole('combobox', { name: 'Tag filter' }).selectOption({
    label: 'portrait',
  })
  await expect(assets(page)).toHaveCount(1)
  await expect(asset(page, 'renamed-alpha.png')).toBeVisible()
  await page.getByRole('combobox', { name: 'Tag filter' }).selectOption('0')

  await page.getByRole('button', { name: 'Archive' }).click()
  await expect(asset(page, 'renamed-alpha.png')).toHaveCount(0)
  await page
    .getByRole('combobox', { name: 'Asset state' })
    .selectOption('archived')
  await expect(asset(page, 'renamed-alpha.png')).toBeVisible()

  await asset(page, 'renamed-alpha.png').click()
  await page.getByRole('button', { name: 'Unarchive' }).click()
  await page
    .getByRole('combobox', { name: 'Asset state' })
    .selectOption('active')
  await expect(asset(page, 'renamed-alpha.png')).toBeVisible()

  await asset(page, 'renamed-alpha.png').click()
  await inspector.getByRole('button', { name: 'Move to trash' }).click()
  const trashDialog = page.getByRole('dialog', {
    name: 'Move 1 asset to trash?',
  })
  await expect(trashDialog).toBeVisible()
  await trashDialog.getByRole('button', { name: 'Move to trash' }).click()
  await expect(asset(page, 'renamed-alpha.png')).toHaveCount(0)
  await openAssetsShelf(page)
  await page
    .getByRole('combobox', { name: 'Asset state' })
    .selectOption('trashed')
  await expect(asset(page, 'renamed-alpha.png')).toBeVisible()

  await asset(page, 'renamed-alpha.png').click()
  await page.getByRole('button', { name: 'Restore from trash' }).click()
  await page
    .getByRole('combobox', { name: 'Asset state' })
    .selectOption('active')
  await expect(asset(page, 'renamed-alpha.png')).toBeVisible()
})

test('rescan discovers new files and exposes missing files', async ({
  page,
}) => {
  await openFixtureRepo(page, 'rescan-fixtures')
  await expect(asset(page, 'rescan-alpha.png')).toBeVisible()

  const addedPath = await fixturePath('rescan-fixtures', 'rescan-added.png')
  await writeFile(addedPath, fixturePng)
  await page.getByTestId('repository-actions').click()
  await expect(
    page
      .getByRole('menu', { name: 'Repository actions' })
      .getByRole('menuitem', {
        name: 'Rescan repository',
      })
  ).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByTestId('open-command-palette').click()
  const search = page.getByRole('combobox', { name: 'Search commands' })
  await search.fill('Rescan repository')
  await expect(
    page.getByRole('option', { name: /Rescan repository/ })
  ).toBeVisible()
  await page.getByRole('option', { name: /Rescan repository/ }).click()
  await expect(asset(page, 'rescan-added.png')).toBeVisible()

  await enterEdit(page)
  await dropAsset(page, 'rescan-alpha.png', { x: 100, y: 100 })
  await rm(await fixturePath('rescan-fixtures', 'rescan-alpha.png'))
  await page.getByTestId('open-command-palette').click()
  await page
    .getByRole('combobox', { name: 'Search commands' })
    .fill('Rescan repository')
  await page.getByRole('option', { name: /Rescan repository/ }).click()
  await openAssetsShelf(page)
  await page.getByRole('button', { name: /^Filters/ }).click()
  await page
    .getByRole('combobox', { name: 'Asset state' })
    .selectOption('missing')
  await expect(asset(page, 'rescan-alpha.png')).toBeVisible()
  await page.getByTestId('open-command-palette').click()
  await page
    .getByRole('combobox', { name: 'Search commands' })
    .fill('@rescan-alpha')
  await page.getByRole('option', { name: /rescan-alpha\.png/ }).click()
  await expect(
    page.getByRole('img', { name: 'File not found on disk' })
  ).toBeVisible()
})

test('show in folders reveals the selected asset location', async ({
  page,
}) => {
  await openFixtureRepo(page, 'folders-fixtures')
  await asset(page, 'folder-delta.png').click()
  await page.getByRole('button', { name: 'Show in Folders' }).click()

  await expect(
    page.getByRole('button', { name: 'Folders', exact: true })
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(asset(page, 'folder-delta.png')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Repository', exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'nested', exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'deeper', exact: true })
  ).toBeVisible()
})
