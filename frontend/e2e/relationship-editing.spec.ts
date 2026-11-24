import type { Page } from '@playwright/test'
import { expect, test } from './test-fixtures'
import {
  autoArrangeCanvas,
  dropAsset,
  imageNodes,
  openFixtureRepo,
} from './test-helpers'

async function clickEdge(page: Page, button: 'left' | 'right', index = 0) {
  const point = await page
    .locator('.react-flow__edge-path')
    .nth(index)
    .evaluate((path) => {
      const element = path as SVGPathElement
      const middle = element.getPointAtLength(element.getTotalLength() / 2)
      const matrix = element.getScreenCTM()
      if (!matrix) throw new Error('edge has no screen transform')
      const screen = new DOMPoint(middle.x, middle.y).matrixTransform(matrix)
      return { x: screen.x, y: screen.y }
    })
  await page.mouse.click(point.x, point.y, { button })
}

test('edge menu reverses and deletes with undo while image Delete does nothing', async ({
  page,
}, testInfo) => {
  await openFixtureRepo(page, 'menu-linux-fixtures')
  await dropAsset(page, 'menu-alpha.png', { x: 100, y: 150 })
  await dropAsset(page, 'menu-beta.png', { x: 450, y: 250 })
  const nodes = imageNodes(page)
  await expect(nodes).toHaveCount(2)
  await nodes.first().click()
  await page.keyboard.press('Delete')
  await expect(nodes).toHaveCount(2)
  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 900, y: 600 } })
  await autoArrangeCanvas(page)

  const first = await nodes.nth(0).boundingBox()
  const second = await nodes.nth(1).boundingBox()
  if (!first || !second) throw new Error('missing canvas nodes')
  await page.keyboard.down('Control')
  await page.mouse.move(first.x + 40, first.y + 40)
  await page.mouse.down()
  await page.mouse.move(second.x + 40, second.y + 40, { steps: 10 })
  await page.mouse.up()
  await page.keyboard.up('Control')
  await page.getByTestId('toggle-inspector-shelf').click()

  const edge = page.locator('.react-flow__edge')
  await expect(edge).toHaveCount(1)
  const originalPath = await edge
    .locator('.react-flow__edge-path')
    .getAttribute('d')
  await clickEdge(page, 'right')
  const menu = page.getByRole('menu')
  await expect(
    menu.getByRole('button', { name: 'Reverse relationship' })
  ).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('edge-menu.png') })
  await menu.getByRole('button', { name: 'Reverse relationship' }).click()
  await expect(edge.locator('.react-flow__edge-path')).not.toHaveAttribute(
    'd',
    originalPath ?? ''
  )
  await page.keyboard.press('ControlOrMeta+z')
  await expect(edge.locator('.react-flow__edge-path')).toHaveAttribute(
    'd',
    originalPath ?? ''
  )

  await clickEdge(page, 'left')
  await page.keyboard.press('Delete')
  await expect(edge).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(edge).toHaveCount(1)
  await expect(nodes).toHaveCount(2)
})

test('resize is one undoable geometry change', async ({ page }) => {
  await openFixtureRepo(page, 'resize-fixtures')
  await dropAsset(page, 'resize-alpha.png', { x: 500, y: 180 })
  const node = imageNodes(page).first()
  await node.click()
  const before = await node.boundingBox()
  const handle = node.locator('.react-flow__resize-control.handle.bottom.right')
  const bounds = await handle.boundingBox()
  if (!before || !bounds) throw new Error('missing resize target')
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(bounds.x + 80, bounds.y + 60, { steps: 5 })
  await page.mouse.up()
  await expect
    .poll(async () => (await node.boundingBox())?.width ?? 0)
    .toBeGreaterThan(before.width + 30)
  await page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(async () => Math.round((await node.boundingBox())?.width ?? 0))
    .toBe(Math.round(before.width))
  await expect
    .poll(async () => Math.round((await node.boundingBox())?.height ?? 0))
    .toBe(Math.round(before.height))
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect
    .poll(async () => (await node.boundingBox())?.width ?? 0)
    .toBeGreaterThan(before.width + 30)
})

test('deleting selected edges is one undoable batch', async ({ page }) => {
  await openFixtureRepo(page, 'group-fixtures')
  for (const [index, name] of [
    'group-alpha.png',
    'group-beta.png',
    'group-gamma.png',
  ].entries()) {
    await dropAsset(page, name, { x: 450 + index * 200, y: 200 })
  }
  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 900, y: 600 } })
  await autoArrangeCanvas(page)
  const nodes = imageNodes(page)
  await expect(nodes).toHaveCount(3)
  for (const index of [0, 1]) {
    const source = await nodes.nth(index).boundingBox()
    const target = await nodes.nth(index + 1).boundingBox()
    if (!source || !target) throw new Error('missing canvas nodes')
    await page.keyboard.down('Control')
    await page.mouse.move(source.x + 40, source.y + 40)
    await page.mouse.down()
    await page.mouse.move(target.x + 40, target.y + 40, { steps: 10 })
    await page.mouse.up()
    await page.keyboard.up('Control')
    await expect(page.locator('.react-flow__edge')).toHaveCount(index + 1)
  }
  await clickEdge(page, 'left', 0)
  await page.keyboard.down('Shift')
  await clickEdge(page, 'left', 1)
  await page.keyboard.up('Shift')
  await expect(page.locator('.react-flow__edge.selected')).toHaveCount(2)
  await page.keyboard.press('Delete')
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  await expect(nodes).toHaveCount(3)
})
