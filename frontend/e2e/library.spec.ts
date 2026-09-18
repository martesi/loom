import { rm, writeFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import {
  asset,
  assets,
  fixturePath,
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

  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } })
  await placeAssets(page, ['root-alpha.png'])
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
  await page.getByRole('button', { name: /deeper/ }).click()
  await expect(asset(page, 'folder-delta.png')).toBeVisible()
  await page.getByRole('button', { name: /Repository/ }).click()
  await expect(asset(page, 'folder-gamma.png')).toBeVisible()
})

test('inspector edits metadata and library filters follow tag/archive/trash state', async ({
  page,
}) => {
  await openFixtureRepo(page, 'inspector-fixtures')
  await asset(page, 'inspect-alpha.png').click()
  await expect(
    page.getByLabel('Inspector').getByText('inspect-alpha.png', { exact: true })
  ).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept('portrait'))
  await page.getByRole('button', { name: 'Add tag' }).click()
  await expect(page.getByText('Common tags: portrait')).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept('soft studio light'))
  await page.getByRole('button', { name: 'Edit prompt' }).click()
  await expect(
    page.getByText('soft studio light', { exact: true })
  ).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept('renamed-alpha.png'))
  await page.getByRole('button', { name: 'Move / rename' }).click()
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
  await page.getByRole('button', { name: 'Rescan' }).click()
  await expect(asset(page, 'rescan-added.png')).toBeVisible()

  await placeAssets(page, ['rescan-alpha.png'])
  await rm(await fixturePath('rescan-fixtures', 'rescan-alpha.png'))
  await page.getByRole('button', { name: 'Rescan' }).click()
  await page
    .getByRole('combobox', { name: 'Asset state' })
    .selectOption('missing')
  await expect(asset(page, 'rescan-alpha.png')).toBeVisible()
  await expect(page.getByTitle('File not found on disk')).toBeVisible()
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
  await expect(page.getByRole('button', { name: /Repository/ })).toContainText(
    'nested/deeper'
  )
})
