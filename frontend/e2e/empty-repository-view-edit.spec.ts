import { expect, test } from './test-fixtures'
import { imageNodes, openFixtureRepo } from './test-helpers'

test('a true empty repository can import media and stage it in Edit', async ({
  page,
}) => {
  await openFixtureRepo(page, 'empty-fixtures', { drawers: 'closed' })
  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(imageNodes(page)).toHaveCount(0)
  await expect(page.getByTestId('empty-canvas-edit')).toBeVisible()
  await expect(page.getByTestId('dock-connect-derivative')).toHaveCount(0)

  await page.locator('input[type=file]').setInputFiles({
    name: 'empty-repository-import.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    ),
  })
  await expect(page.getByTestId('canvas-mode-edit')).toContainText('1')
  await expect(imageNodes(page)).toHaveCount(0)
  await page.getByTestId('empty-canvas-edit').click()
  await expect(page.getByTestId('canvas-mode-edit')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(imageNodes(page)).toHaveCount(1)
  await expect(imageNodes(page).first()).toHaveAccessibleName(
    'Image: empty-repository-import.png'
  )
})
