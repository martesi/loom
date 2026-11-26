import { expect, test } from './test-fixtures'
import {
  autoArrangeCanvas,
  ctrlDrag,
  dropAsset,
  imageNodes,
  openFixtureRepo,
} from './test-helpers'

test('resize and link replay in order without moving unrelated nodes', async ({
  page,
}, testInfo) => {
  await openFixtureRepo(page, 'group-fixtures')
  await page.getByTestId('canvas-mode-edit').click()
  for (const [index, name] of [
    'group-alpha.png',
    'group-beta.png',
    'group-gamma.png',
  ].entries())
    await dropAsset(page, name, { x: 400 + index * 220, y: 200 })
  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 900, y: 600 } })
  await autoArrangeCanvas(page)
  const nodes = imageNodes(page)
  await expect(nodes).toHaveCount(3)
  const first = nodes.nth(0)
  const bounds = async () =>
    nodes.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect()
        return [box.x, box.y, box.width, box.height].map(Math.round)
      })
    )
  await first.click()
  const before = await bounds()
  const handle = await first
    .locator('.react-flow__resize-control.handle.top.left')
    .boundingBox()
  if (!handle) throw new Error('missing resize handle')
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(handle.x - 80, handle.y - 60, { steps: 5 })
  await page.mouse.up()
  await expect
    .poll(async () => (await bounds())[0][2])
    .toBeGreaterThan(before[0][2] + 30)
  const resized = await bounds()
  await ctrlDrag(page, first, nodes.nth(1))
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
  await expect.poll(bounds).toEqual(resized)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(bounds).toEqual(before)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(bounds).toEqual(resized)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await expect.poll(bounds).toEqual(resized)
  await page.screenshot({ path: testInfo.outputPath('history-replayed.png') })
})
