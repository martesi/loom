import type { Locator, Page } from '@playwright/test'
import { expect, test } from './test-fixtures'
import {
  asset,
  autoArrangeCanvas,
  ctrlDrag,
  dropAsset,
  imageNodes,
  nodeBox,
  openFixtureRepo,
  placeAssets,
  selectImageNodes,
} from './test-helpers'

async function dragBy(page: Page, locator: Locator, dx: number, dy: number) {
  const box = await nodeBox(locator)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    box.x + box.width / 2 + dx,
    box.y + box.height / 2 + dy,
    { steps: 8 }
  )
  await page.mouse.up()
}

test('relationships reject cycles, support ctrl-click selection, and delete as edges', async ({
  page,
}) => {
  await openFixtureRepo(page, 'relationship-fixtures')
  await placeAssets(page, [
    'relation-alpha.png',
    'relation-beta.png',
    'relation-gamma.png',
  ])
  await autoArrangeCanvas(page)
  await page.keyboard.press('ControlOrMeta+0')

  const nodes = imageNodes(page)
  await nodes.nth(0).click()
  await expect(page.getByText(/Ctrl\/Cmd-drag this image/)).toBeVisible()

  const first = await nodeBox(nodes.nth(0))
  const second = await nodeBox(nodes.nth(1))
  await page.keyboard.down('Control')
  await page.mouse.move(first.x + 30, first.y + 30)
  await page.mouse.down()
  await page.mouse.move(first.x + 32, first.y + 32)
  await expect(page.getByRole('status')).toHaveCount(0)
  await expect(page.getByTestId('relationship-preview')).toHaveCount(0)
  await page.mouse.move(second.x + 30, second.y + 30, { steps: 8 })
  await expect(page.getByTestId('relationship-preview')).toBeVisible()
  await expect(
    page.getByTestId('relationship-preview').locator('line')
  ).toHaveClass(/stroke-green-500/)
  await expect(page.getByRole('status')).toHaveText(
    'Release to create relationship'
  )
  await expect(nodes.nth(1)).toHaveClass(/ring-green-500/)
  await page.mouse.up()
  await page.keyboard.up('Control')
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  const persistedEdge = page.locator('.react-flow__edge-path')
  await expect(persistedEdge).toHaveAttribute('marker-end', /url/)
  await expect(persistedEdge).toHaveCSS('stroke-width', '2px')
  await expect
    .poll(async () =>
      persistedEdge.evaluate((path) => {
        const rect = path.getBoundingClientRect()
        return Math.max(rect.width, rect.height)
      })
    )
    .toBeGreaterThan(0)

  await page.keyboard.down('Control')
  await page.mouse.move(second.x + 30, second.y + 30)
  await page.mouse.down()
  await page.mouse.move(first.x + 30, first.y + 30, { steps: 8 })
  await expect(page.getByRole('status')).toHaveText(
    'This relationship would create a cycle'
  )
  await expect(nodes.nth(0)).toHaveClass(/ring-red-500/)
  await page.mouse.up()
  await page.keyboard.up('Control')
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)

  await autoArrangeCanvas(page)
  await expect
    .poll(async () => {
      const source = await nodeBox(nodes.nth(0))
      const derived = await nodeBox(nodes.nth(1))
      return source.x + source.width < derived.x
    })
    .toBe(true)

  const third = await nodeBox(nodes.nth(2))
  await page.keyboard.down('Control')
  await page.mouse.click(third.x + 20, third.y + 20)
  await page.keyboard.up('Control')
  await expect(nodes.nth(2)).toHaveClass(/selected/)

  await page.keyboard.down('Control')
  await page.mouse.click(third.x + 20, third.y + 20)
  await page.keyboard.up('Control')
  await expect(nodes.nth(2)).not.toHaveClass(/selected/)

  const edge = page.getByRole('group', { name: /Edge from/ })
  await edge.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.react-flow__edge.selected')).toHaveCount(1)
  await page.getByTestId('toggle-inspector-shelf').click()
  await expect(
    page.getByRole('heading', { name: '1 relationship', exact: true })
  ).toBeVisible()
  await page.keyboard.press('Delete')
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
})

test('relationship gestures reject self-links', async ({ page }) => {
  await openFixtureRepo(page, 'relationship-self-link-fixtures')
  await placeAssets(page, ['relation-alpha.png'])
  await page.keyboard.press('ControlOrMeta+0')

  const node = imageNodes(page).first()
  const box = await nodeBox(node)
  await page.keyboard.down('Control')
  await page.mouse.move(box.x + 40, box.y + 40)
  await page.mouse.down()
  await page.mouse.move(box.x + 70, box.y + 65, { steps: 6 })
  await expect(page.getByRole('status')).toHaveText(
    'An image cannot be related to itself'
  )
  await expect(
    page.getByTestId('relationship-preview').locator('line')
  ).toHaveClass(/stroke-red-500/)
  await page.mouse.up()
  await page.keyboard.up('Control')

  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
})

test('collapsed sets cannot be relationship sources', async ({ page }) => {
  await openFixtureRepo(page, 'set-source-fixtures')
  await placeAssets(page, [
    'group-alpha.png',
    'group-beta.png',
    'group-gamma.png',
  ])
  await page.keyboard.press('ControlOrMeta+0')
  await selectImageNodes(page, [0, 1])
  await page.getByTestId('dock-create-set').click()

  const group = page.locator('.react-flow__node-group')
  await expect(group).toHaveCount(1)
  const groupBox = await nodeBox(group)
  const targetBox = await nodeBox(imageNodes(page).first())
  await page.keyboard.down('Control')
  await page.mouse.move(
    groupBox.x + groupBox.width / 2,
    groupBox.y + groupBox.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(
    groupBox.x + groupBox.width / 2 + 12,
    groupBox.y + groupBox.height / 2 + 8,
    { steps: 2 }
  )
  await expect(page.getByTestId('relationship-preview')).toHaveCount(0)
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 8 }
  )
  await expect(page.getByTestId('relationship-preview')).toHaveCount(0)
  await page.mouse.up()
  await page.keyboard.up('Control')

  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
})

test('Sources navigation reveals and selects an unplaced asset', async ({
  page,
}) => {
  await openFixtureRepo(page, 'sources-nav-fixtures')
  await placeAssets(page, ['relation-alpha.png', 'relation-beta.png'])
  await page.keyboard.press('ControlOrMeta+0')
  await ctrlDrag(page, imageNodes(page).nth(0), imageNodes(page).nth(1))
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)

  await imageNodes(page).nth(0).click()
  await page.getByTestId('dock-unplace').click()
  await expect(imageNodes(page)).toHaveCount(1)
  await imageNodes(page).first().click()

  const sources = page
    .locator('.loom-detail-panel section')
    .filter({ has: page.getByRole('heading', { name: 'Sources' }) })
  await expect(sources.getByText('relation-alpha.png')).toBeVisible()
  await sources.getByRole('button', { name: /Go to source asset/ }).click()

  await expect(asset(page, 'relation-alpha.png')).toHaveAttribute(
    'aria-selected',
    'true'
  )
  // Locate scrolls the row into view, not just selects it.
  await expect
    .poll(async () => {
      const rowBox = await asset(page, 'relation-alpha.png').boundingBox()
      const listBox = await page
        .getByRole('listbox', { name: 'Assets' })
        .boundingBox()
      if (!rowBox || !listBox) return false
      return (
        rowBox.y >= listBox.y &&
        rowBox.y + rowBox.height <= listBox.y + listBox.height
      )
    })
    .toBe(true)
  await expect(page.getByText(/× .* · Unplaced/)).toBeVisible()
})

test('auto-arrange respects resized node bounds', async ({ page }) => {
  await openFixtureRepo(page, 'arrange-resize-fixtures')
  await placeAssets(page, ['arrange-alpha.png', 'arrange-beta.png'])
  await page.keyboard.press('ControlOrMeta+0')

  const nodes = imageNodes(page)
  await nodes.first().click()
  const beforeResize = await nodeBox(nodes.first())
  const handle = page.locator('.react-flow__resize-control.handle').last()
  await expect(handle).toBeVisible()
  await dragBy(page, handle, 220, 80)
  await expect
    .poll(async () => (await nodeBox(nodes.first())).width)
    .toBeGreaterThan(beforeResize.width + 150)
  await autoArrangeCanvas(page)

  await expect
    .poll(async () => {
      const first = await nodeBox(nodes.nth(0))
      const second = await nodeBox(nodes.nth(1))
      return (
        first.x + first.width <= second.x ||
        second.x + second.width <= first.x ||
        first.y + first.height <= second.y ||
        second.y + second.height <= first.y
      )
    })
    .toBe(true)

  await dropAsset(page, 'arrange-gamma.png', { x: 500, y: 450 })
  await expect(nodes).toHaveCount(3)
  await selectImageNodes(page, [1, 2])
  await nodes.nth(1).click({ button: 'right' })
  await page
    .getByRole('menu')
    .getByRole('button', { name: 'Auto-arrange selection' })
    .click()
  await expect
    .poll(async () => {
      const obstacle = await nodeBox(nodes.nth(0))
      const second = await nodeBox(nodes.nth(1))
      const third = await nodeBox(nodes.nth(2))
      return Math.min(second.y, third.y) >= obstacle.y + obstacle.height + 50
    })
    .toBe(true)
})
