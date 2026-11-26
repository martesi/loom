import { access } from 'node:fs/promises'
import { runtimeMethodID } from './bindings'
import { expect, test } from './test-fixtures'
import { fixturePath, openAssetsShelf, openFixtureRepo } from './test-helpers'

test('Undo keeps imported media on disk and Assets can explicitly recover it', async ({
  page,
}) => {
  await openFixtureRepo(page, 'clipboard-fixtures', { drawers: 'assets' })
  await expect(page.getByTestId('import-recovery-panel')).toBeVisible()
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
  await expect(page.getByText('image 2 not found')).toHaveCount(0)
  await expect(page.getByTestId('import-recovery-panel')).toBeVisible()
  await expect(page.getByTestId('import-recovery-trigger')).toBeVisible()
  await access(originalPath)

  await page.reload()
  await openAssetsShelf(page)
  await expect(page.getByTestId('import-recovery-panel')).toBeVisible()
  await expect(page.getByTestId('import-recovery-trigger')).toBeVisible()

  const listRecoverableMethodID = runtimeMethodID(
    'imageservice.ts',
    'ListRecoverableImports'
  )
  const recoverableIPC = page.waitForResponse(
    (response) =>
      response.url().endsWith('/wails/runtime') &&
      response
        .request()
        .postData()
        ?.includes(`"methodID":${listRecoverableMethodID}`) === true
  )
  await page.getByTestId('import-recovery-trigger').click()
  expect((await recoverableIPC).ok()).toBe(true)
  const dialog = page.getByTestId('import-recovery-dialog')
  await expect(dialog).toBeVisible()
  const retained = dialog.getByTestId('retained-import')
  await expect(retained).toBeVisible()
  await expect(retained).toHaveAttribute('data-recovery-status', 'verified')
  await expect(retained.getByText(originalPath)).toBeVisible()
  const restore = retained.getByTestId('restore-retained-import')
  await expect(restore).toBeEnabled()
  await restore.click()
  const redoConfirmation = dialog.getByTestId('redo-replacement-confirmation')
  await expect(redoConfirmation).toBeVisible()
  await dialog.getByTestId('confirm-redo-replacement').click()
  await expect(importedRow).toBeVisible()
  await expect(importedRow).toHaveAttribute('data-asset-id', originalID ?? '')
  await access(originalPath)
})
