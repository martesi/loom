import { rm, writeFile } from 'node:fs/promises'
import { expect, test } from './test-fixtures'
import {
  asset,
  assets,
  dropAsset,
  fixturePath,
  imageNodes,
  openAssetsShelf,
  openFixtureRepo,
  placeAssets,
} from './test-helpers'

const fixturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

test('library selection, search, placement filters, and folder navigation', async ({
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
  await placeAssets(page, ['root-alpha.png'])
  await openAssetsShelf(page)
  await filters.click()
  await page.getByRole('combobox', { name: 'Placement' }).selectOption('placed')
  await expect(assets(page)).toHaveCount(1)
  await expect(asset(page, 'root-alpha.png')).toBeVisible()

  await page
    .getByRole('combobox', { name: 'Placement' })
    .selectOption('unplaced')
  await expect(assets(page)).toHaveCount(3)
  await expect(asset(page, 'root-alpha.png')).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Placement' }).selectOption('')

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
  await expect(asset(page, 'renamed-gamma.png')).toBeVisible()
})

test('asset selection survives view switches and multi-row drag transfers selection to Canvas', async ({
  page,
}) => {
  await openFixtureRepo(page, 'library-selection-fixtures')
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
  await expect(imageNodes(page)).toHaveCount(2)
  await expect(selectedAssets).toHaveCount(0)
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)

  await dropAsset(page, 'root-alpha.png', { x: 480, y: 220 })
  await expect(imageNodes(page)).toHaveCount(2)
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
  await inspector.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(inspector.getByText('Common: portrait')).toBeVisible()

  await inspector.getByLabel('Prompt').fill('soft studio light')
  await inspector.getByRole('button', { name: 'Save prompt' }).click()
  await expect(inspector.getByLabel('Prompt')).toHaveValue('soft studio light')

  await inspector.getByLabel('File path').fill('renamed-alpha.png')
  await inspector.getByRole('button', { name: 'Move', exact: true }).click()
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
  await page.keyboard.press('Delete')
  await expect(asset(page, 'renamed-alpha.png')).toHaveCount(0)
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
  await page
    .getByRole('menu', { name: 'Repository actions' })
    .getByRole('menuitem', { name: 'Rescan repository' })
    .click()
  await expect(asset(page, 'rescan-added.png')).toBeVisible()

  await placeAssets(page, ['rescan-alpha.png'])
  await rm(await fixturePath('rescan-fixtures', 'rescan-alpha.png'))
  await page.getByTestId('repository-actions').click()
  await page
    .getByRole('menu', { name: 'Repository actions' })
    .getByRole('menuitem', { name: 'Rescan repository' })
    .click()
  await openAssetsShelf(page)
  await page.getByRole('button', { name: /^Filters/ }).click()
  await page
    .getByRole('combobox', { name: 'Asset state' })
    .selectOption('missing')
  await expect(asset(page, 'rescan-alpha.png')).toBeVisible()
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
