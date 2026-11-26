import { access } from 'node:fs/promises'
import { expect, test } from './test-fixtures'
import { fixturePath, openFixtureRepo } from './test-helpers'

test('Undo keeps imported media on disk and Assets can explicitly recover it', async ({
  page,
}) => {
  await openFixtureRepo(page, 'clipboard-fixtures', { drawers: 'assets' })
  const importedName = 'undo-recover.png'
  const importedRow = page
    .locator('[data-asset-id]')
    .filter({ hasText: importedName })
  await page.locator('input[type=file]').setInputFiles({
    name: importedName,
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    ),
  })
  await expect(importedRow).toBeVisible()
  const originalID = await importedRow.getAttribute('data-asset-id')
  const originalPath = await fixturePath('clipboard-fixtures', importedName)

  await page.keyboard.press('ControlOrMeta+z')
  await expect(importedRow).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: /import recovery/i })
  ).toBeVisible()
  await access(originalPath)

  await page.getByRole('button', { name: /import recovery/i }).click()
  const dialog = page.getByRole('dialog', { name: 'Import recovery' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(originalPath)).toBeVisible()
  await expect(
    dialog.getByText('Original file fingerprint verified.')
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Restore verified import' }).click()
  await expect(importedRow).toBeVisible()
  await expect(importedRow).toHaveAttribute('data-asset-id', originalID ?? '')
  await access(originalPath)
})
