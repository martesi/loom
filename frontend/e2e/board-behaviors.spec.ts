import { DatabaseSync } from 'node:sqlite'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './test-fixtures'
import {
  asset,
  autoArrangeCanvas,
  ctrlDrag,
  enterEdit,
  fixturePath,
  imageNodes,
  nodeBox,
  openAssetsShelf,
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

test('multi-image drag is one undoable geometry change', async ({
  page,
}, testInfo) => {
  await openFixtureRepo(page, 'arrange-resize-fixtures')
  await enterEdit(page)
  await expect(imageNodes(page)).toHaveCount(3)
  await page.keyboard.press('ControlOrMeta+0')
  const nodes = imageNodes(page)
  await nodes.first().click()
  const handle = page.locator('.react-flow__resize-control.handle').last()
  await dragBy(page, handle, 70, 40)
  await selectImageNodes(page, [0, 1])
  const before = await Promise.all([
    nodeBox(nodes.nth(0)),
    nodeBox(nodes.nth(1)),
  ])
  await dragBy(page, nodes.first(), 75, 45)
  await expect
    .poll(async () => (await nodeBox(nodes.first())).x - before[0].x)
    .toBeGreaterThan(50)
  const after = await Promise.all([
    nodeBox(nodes.nth(0)),
    nodeBox(nodes.nth(1)),
  ])
  expect(after[1].x - before[1].x).toBeGreaterThan(50)
  await testInfo.attach('multi-image-drag', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })

  const expectBoxes = async (expected: typeof before) => {
    await expect
      .poll(async () => {
        const actual = await Promise.all([
          nodeBox(nodes.nth(0)),
          nodeBox(nodes.nth(1)),
        ])
        return actual.every((box, index) =>
          (['x', 'y', 'width', 'height'] as const).every(
            (key) => Math.abs(box[key] - expected[index][key]) < 1
          )
        )
      })
      .toBe(true)
  }
  await page.keyboard.press('ControlOrMeta+z')
  await expectBoxes(before)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expectBoxes(after)
})

test('relationships reject cycles, support ctrl-click selection, and delete as edges', async ({
  page,
}) => {
  await openFixtureRepo(page, 'relationship-fixtures')
  await enterEdit(page)
  await expect(imageNodes(page)).toHaveCount(3)
  await autoArrangeCanvas(page)
  await page.keyboard.press('ControlOrMeta+0')

  const nodes = imageNodes(page)
  await nodes.nth(0).click()
  if (
    (await page
      .locator('aside[aria-label="Inspector"]')
      .getAttribute('data-state')) !== 'open'
  )
    await page.getByTestId('toggle-inspector-shelf').click()

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
  if (
    (await page
      .locator('aside[aria-label="Inspector"]')
      .getAttribute('data-state')) !== 'open'
  )
    await page.getByTestId('toggle-inspector-shelf').click()
  await expect(
    page.getByRole('heading', { name: '1 relationship', exact: true })
  ).toBeVisible()
  await edge.focus()
  await page.keyboard.press('Delete')
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
})

test('relationship gestures reject self-links', async ({ page }) => {
  await openFixtureRepo(page, 'relationship-self-link-fixtures')
  await enterEdit(page)
  await expect(imageNodes(page)).toHaveCount(1)
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

test('Sources navigation selects a visible unplaced source in Edit', async ({
  page,
}) => {
  await openFixtureRepo(page, 'sources-nav-fixtures')
  await enterEdit(page)
  await placeAssets(page, ['relation-alpha.png', 'relation-beta.png'])
  await page.keyboard.press('ControlOrMeta+0')
  await ctrlDrag(page, imageNodes(page).nth(0), imageNodes(page).nth(1))
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)

  await openAssetsShelf(page)
  const sourceID = Number(
    await asset(page, 'relation-alpha.png').getAttribute('data-asset-id')
  )
  const db = new DatabaseSync(
    `${await fixturePath('sources-nav-fixtures')}/.loom/db.sqlite`
  )
  db.prepare('UPDATE images SET canvas_x=NULL,canvas_y=NULL WHERE id=?').run(
    sourceID
  )
  db.close()
  await page.reload()
  await expect(imageNodes(page)).toHaveCount(2)
  await openAssetsShelf(page)
  await asset(page, 'relation-alpha.png').click()
  if (
    (await page
      .locator('aside[aria-label="Inspector"]')
      .getAttribute('data-state')) !== 'open'
  )
    await page.getByTestId('toggle-inspector-shelf').click()
  await expect(page.getByText(/× .* · Unplaced/)).toBeVisible()
  await page.getByTestId('toggle-assets-shelf').click()
  const sourceNode = imageNodes(page).filter({ hasText: 'relation-alpha.png' })
  const derivedNode = imageNodes(page).filter({ hasText: 'relation-beta.png' })
  await derivedNode.click()

  const sources = page
    .locator('.loom-detail-panel section')
    .filter({ has: page.getByRole('heading', { name: 'Sources' }) })
  await expect(sources.getByText('relation-alpha.png')).toBeVisible()
  await sources.getByRole('button', { name: /Go to source asset/ }).click()

  await expect(sourceNode).toHaveClass(/selected/)
  await expect(derivedNode).not.toHaveClass(/selected/)
  await expect(page.getByText(/× .* · Unplaced/)).toBeVisible()
})

test('auto-arrange respects resized node bounds', async ({ page }) => {
  await openFixtureRepo(page, 'arrange-resize-fixtures')
  await enterEdit(page)
  await expect(imageNodes(page)).toHaveCount(3)
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

  await expect(nodes).toHaveCount(3)
  await selectImageNodes(page, [1, 2])
  await nodes.nth(1).click({ button: 'right' })
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: 'Auto-arrange selection' })
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
