import type { Locator, Page } from '@playwright/test'
import { legacyServiceCall } from './legacy-service'
import { expect, test } from './test-fixtures'
import {
  asset,
  autoArrangeCanvas,
  ctrlDrag,
  dropAsset,
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
  await openFixtureRepo(page, 'arrange-resize-pair-fixtures')
  await page.getByTestId('canvas-mode-edit').click()
  await placeAssets(page, ['arrange-alpha.png', 'arrange-beta.png'])
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
  await page.getByTestId('canvas-mode-edit').click()
  await placeAssets(page, [
    'relation-alpha.png',
    'relation-beta.png',
    'relation-gamma.png',
  ])
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
  await page.getByTestId('canvas-mode-edit').click()
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

test('Sources navigation reveals and selects an unplaced asset', async ({
  page,
}) => {
  await openFixtureRepo(page, 'sources-nav-fixtures')
  await page.getByTestId('canvas-mode-edit').click()
  await placeAssets(page, ['relation-alpha.png', 'relation-beta.png'])
  await page.keyboard.press('ControlOrMeta+0')
  await ctrlDrag(page, imageNodes(page).nth(0), imageNodes(page).nth(1))
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)

  await openAssetsShelf(page)
  const sourceID = Number(
    await asset(page, 'relation-alpha.png').getAttribute('data-asset-id')
  )
  const derivedID = Number(
    await asset(page, 'relation-beta.png').getAttribute('data-asset-id')
  )
  await legacyServiceCall(page, 'imageservice.ts', 'UnplaceImages', [
    await fixturePath('sources-nav-fixtures'),
    [sourceID],
  ])
  await page.reload()
  await expect(imageNodes(page)).toHaveCount(2)
  const source = await legacyServiceCall<{
    placed: boolean
  } | null>(page, 'imageservice.ts', 'GetImage', [
    await fixturePath('sources-nav-fixtures'),
    sourceID,
  ])
  expect(source?.placed).toBe(false)
  const sourceNode = page.locator(`.react-flow__node[data-id="${sourceID}"]`)
  const derivedNode = page.locator(`.react-flow__node[data-id="${derivedID}"]`)
  await expect(sourceNode).toHaveCount(1)
  await expect(derivedNode).toHaveCount(1)
  await derivedNode.click()
  if (
    (await page
      .locator('aside[aria-label="Inspector"]')
      .getAttribute('data-state')) !== 'open'
  )
    await page.getByTestId('toggle-inspector-shelf').click()

  const sources = page
    .locator('.loom-detail-panel section')
    .filter({ has: page.getByRole('heading', { name: 'Sources' }) })
  await expect(sources.getByText('relation-alpha.png')).toBeVisible()
  const viewport = page.locator('.react-flow__viewport')
  const initialViewport = await viewport.getAttribute('style')
  await sources.getByRole('button', { name: /Go to source asset/ }).click()

  await expect(sourceNode).toHaveClass(/selected/)
  await expect(viewport).not.toHaveAttribute('style', initialViewport ?? '')
  await expect
    .poll(async () => {
      const canvas = await page.locator('.react-flow__pane').boundingBox()
      const node = await sourceNode.boundingBox()
      if (!canvas || !node) return Number.POSITIVE_INFINITY
      return Math.max(
        Math.abs(node.x + node.width / 2 - (canvas.x + canvas.width / 2)),
        Math.abs(node.y + node.height / 2 - (canvas.y + canvas.height / 2))
      )
    })
    .toBeLessThan(20)
  await expect(page.getByText(/× .* · Unplaced/)).toBeVisible()
})

test('Assets reveals an unpaired unplaced asset without projecting a node', async ({
  page,
}) => {
  await openFixtureRepo(page, 'clipboard-fixtures')
  await page.getByTestId('canvas-mode-edit').click()
  await openAssetsShelf(page)
  const id = Number(
    await asset(page, 'hover-target.png').getAttribute('data-asset-id')
  )
  await placeAssets(page, ['hover-target.png'])
  await legacyServiceCall(page, 'imageservice.ts', 'UnplaceImages', [
    await fixturePath('clipboard-fixtures'),
    [id],
  ])
  await page.reload()
  await expect(imageNodes(page)).toHaveCount(0)
  await openAssetsShelf(page)
  await expect(asset(page, 'hover-target.png')).toBeVisible()
  await asset(page, 'hover-target.png').click()
  await expect(asset(page, 'hover-target.png')).toHaveAttribute(
    'aria-selected',
    'true'
  )
})

test('auto-arrange respects resized node bounds', async ({ page }) => {
  await openFixtureRepo(page, 'arrange-resize-pair-fixtures')
  await page.getByTestId('canvas-mode-edit').click()
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

  await page.locator('input[type=file]').setInputFiles({
    name: 'arrange-gamma.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    ),
  })
  await expect(nodes).toHaveCount(3)
  await dropAsset(page, 'arrange-gamma.png', { x: 500, y: 450 })
  await expect(nodes).toHaveCount(3)
  await selectImageNodes(page, [1, 2])
  const selectedIDs = await Promise.all(
    [1, 2].map((index) => nodes.nth(index).getAttribute('data-id'))
  )
  if (selectedIDs.some((id) => !id))
    throw new Error('Selected arrangement nodes have no IDs')
  const positions = async () =>
    Promise.all(
      [1, 2].map(async (index) => {
        const box = await nodeBox(nodes.nth(index))
        return { x: Math.round(box.x), y: Math.round(box.y) }
      })
    )
  const beforeSelected = await positions()
  const obstacleBefore = await nodeBox(nodes.nth(0))
  const repoPath = await fixturePath('arrange-resize-pair-fixtures')
  const beforeSnapshot = await legacyServiceCall<{
    images?: { id: number; geometry: unknown }[]
  }>(page, 'imageservice.ts', 'GetLayoutSnapshot', [repoPath])
  const beforeGeometry = new Map(
    (beforeSnapshot.images ?? []).map((image) => [image.id, image.geometry])
  )
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
  const afterSelected = await positions()
  expect(afterSelected).not.toEqual(beforeSelected)
  const obstacleAfter = await nodeBox(nodes.nth(0))
  expect(obstacleAfter.x).toBeCloseTo(obstacleBefore.x, 0)
  expect(obstacleAfter.y).toBeCloseTo(obstacleBefore.y, 0)
  expect(obstacleAfter.width).toBeCloseTo(obstacleBefore.width, 0)
  expect(obstacleAfter.height).toBeCloseTo(obstacleBefore.height, 0)
  const afterSnapshot = await legacyServiceCall<{
    images?: { id: number; geometry: unknown }[]
  }>(page, 'imageservice.ts', 'GetLayoutSnapshot', [repoPath])
  const afterGeometry = new Map(
    (afterSnapshot.images ?? []).map((image) => [image.id, image.geometry])
  )
  for (const id of selectedIDs) {
    const numericID = Number(id)
    expect(afterGeometry.get(numericID)).not.toEqual(
      beforeGeometry.get(numericID)
    )
  }
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(positions).toEqual(beforeSelected)
  const undone = await legacyServiceCall<{
    images?: { id: number; geometry: unknown }[]
  }>(page, 'imageservice.ts', 'GetLayoutSnapshot', [repoPath])
  expect(
    new Map((undone.images ?? []).map((image) => [image.id, image.geometry]))
  ).toEqual(beforeGeometry)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(positions).toEqual(afterSelected)
  const redone = await legacyServiceCall<{
    images?: { id: number; geometry: unknown }[]
  }>(page, 'imageservice.ts', 'GetLayoutSnapshot', [repoPath])
  expect(
    new Map((redone.images ?? []).map((image) => [image.id, image.geometry]))
  ).toEqual(afterGeometry)
})
