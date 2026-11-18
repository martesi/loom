import { expect, test } from './test-fixtures'
import { asset, assets, openFixtureRepo } from './test-helpers'

test('compression plugin creates copies and replaces representations without changing identity', async ({
  page,
}) => {
  await openFixtureRepo(page, 'image-tools-fixtures')

  const original = asset(page, 'image-tools-alpha.png')
  await expect(original).toHaveCount(1)
  const originalId = await original.getAttribute('data-asset-id')

  await original.click({ button: 'right' })
  await page
    .getByRole('menu')
    .getByRole('button', { name: 'Compress…' })
    .click()

  const dialog = page.getByRole('dialog', { name: 'Compress images' })
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(dialog).toContainText('1 asset selected')
  await expect(dialog.getByLabel('Compression result')).toHaveValue('copy')
  await dialog.getByRole('button', { name: 'Compress', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('1 compressed')
  await expect(assets(page)).toHaveCount(2)
  await expect(asset(page, 'image-tools-alpha.avif')).toHaveCount(1)
  await dialog.getByRole('button', { name: 'Close operation' }).click()

  await asset(page, 'image-tools-alpha.png').click({ button: 'right' })
  await page
    .getByRole('menu')
    .getByRole('button', { name: 'Compress…' })
    .click()
  const replaceDialog = page.getByRole('dialog', { name: 'Compress images' })
  await replaceDialog.getByLabel('Compression result').selectOption('replace')
  await expect(replaceDialog.getByLabel('Compression result')).toHaveValue(
    'replace'
  )
  await replaceDialog
    .getByRole('button', { name: 'Compress', exact: true })
    .click()
  await expect(replaceDialog.getByRole('status')).toHaveText('1 compressed')
  await expect(assets(page)).toHaveCount(2)
  await expect(asset(page, 'image-tools-alpha.png')).toHaveCount(0)

  const replaced = assets(page).filter({
    hasText: 'image-tools-alpha (1).avif',
  })
  await expect(replaced).toHaveCount(1)
  await expect(replaced).toHaveAttribute('data-asset-id', originalId ?? '')
  await replaceDialog.getByRole('button', { name: 'Close operation' }).click()
})
