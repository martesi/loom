import { expect, test } from './test-fixtures'
import {
  imageNodes,
  openFixtureRepo,
  placeAssets,
  selectImageNodes,
} from './test-helpers'

test('an empty canvas keeps its assets available', async ({ page }) => {
  await openFixtureRepo(page, 'canvas-fixtures')
  await expect(imageNodes(page)).toHaveCount(0)
  await expect(
    page.getByRole('heading', { name: 'Start with an asset' })
  ).toBeVisible()
  await expect(
    page.getByText('Drag an asset from Assets onto the canvas.')
  ).toBeVisible()
  await expect(
    page.getByText('Ctrl/Cmd-drag image → image to create a relationship.')
  ).toBeVisible()
  await expect(
    page.getByRole('option', { name: /canvas-alpha.png/ })
  ).toBeVisible()
})

test('Canvas selection does not create sets or delete images', async ({
  page,
}, testInfo) => {
  await openFixtureRepo(page, 'group-pair-fixtures')
  await page.getByTestId('canvas-mode-edit').click()
  await placeAssets(page, ['group-alpha.png', 'group-beta.png'])
  await page.keyboard.press('ControlOrMeta+0')
  await selectImageNodes(page, [0, 1])
  await expect(page.getByTestId('dock-create-set')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+g')
  await expect(imageNodes(page)).toHaveCount(2)
  await expect(page.locator('.react-flow__node-group')).toHaveCount(0)
  await page.keyboard.press('Delete')
  await expect(imageNodes(page)).toHaveCount(2)
  await page.reload()
  await expect(imageNodes(page)).toHaveCount(2)
  await testInfo.attach('individual-images', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
})
