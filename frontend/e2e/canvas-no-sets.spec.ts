import { expect, test } from './test-fixtures'
import {
  imageNodes,
  openFixtureRepo,
  placeAssets,
  selectImageNodes,
} from './test-helpers'

test('Canvas selection does not create sets or delete images', async ({
  page,
}, testInfo) => {
  await openFixtureRepo(page, 'group-fixtures')
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
