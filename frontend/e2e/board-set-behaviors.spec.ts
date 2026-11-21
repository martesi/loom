import type { Locator, Page } from '@playwright/test'
import { expect, test } from './test-fixtures'
import {
  asset,
  autoArrangeCanvas,
  ctrlDrag,
  dropAsset,
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

test('sets persist metadata and movement, accept source links, expand, and dissolve', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures')
  await placeAssets(page, [
    'group-alpha.png',
    'group-beta.png',
    'group-gamma.png',
  ])
  await autoArrangeCanvas(page)
  await page.keyboard.press('ControlOrMeta+0')
  await selectImageNodes(page, [0, 1])
  await page.getByTestId('dock-create-set').click()

  let group = page.locator('.react-flow__node-group')
  await expect(group).toHaveCount(1)
  await expect(imageNodes(page)).toHaveCount(1)

  await group.click()
  await page.getByTestId('toggle-inspector-shelf').click()
  const name = page.getByLabel('Set name')
  await name.fill('Pair')
  await name.blur()
  const kind = page.getByLabel('Kind')
  await kind.fill('variant')
  await kind.blur()
  await expect(group).toContainText('Pair · 2')

  await page.getByRole('button', { name: 'Compare', exact: true }).click()
  const comparison = page.getByRole('dialog', { name: 'Compare Pair' })
  await expect(comparison).toBeVisible()
  await expect(comparison.getByRole('article')).toHaveCount(2)
  await comparison.getByRole('button', { name: 'Zoom in' }).click()
  await expect(comparison.getByText('125%')).toBeVisible()
  const alphaImage = comparison.getByRole('img', { name: 'group-alpha.png' })
  const betaImage = comparison.getByRole('img', { name: 'group-beta.png' })
  await expect(alphaImage).toHaveAttribute('style', /scale\(1\.25\)/)
  const alphaBox = await alphaImage.boundingBox()
  if (!alphaBox) throw new Error('comparison image has no bounding box')
  await page.mouse.move(
    alphaBox.x + alphaBox.width / 2,
    alphaBox.y + alphaBox.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(
    alphaBox.x + alphaBox.width / 2 + 30,
    alphaBox.y + alphaBox.height / 2 + 20
  )
  await page.mouse.up()
  await expect(alphaImage).toHaveAttribute('style', /translate\(30px, 20px\)/)
  await expect(betaImage).toHaveAttribute('style', /translate\(30px, 20px\)/)
  const beta = comparison.getByRole('article', { name: 'group-beta.png' })
  await beta.getByRole('button', { name: 'Use as cover' }).click()
  await expect(beta.getByText('Cover', { exact: true })).toBeVisible()
  await comparison.getByRole('button', { name: 'Close comparison' }).click()
  await expect(comparison).toHaveCount(0)
  await page.getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(comparison.getByText('100%')).toBeVisible()
  await expect(
    comparison.getByRole('img', { name: 'group-alpha.png' })
  ).toHaveAttribute('style', /translate\(0px, 0px\) scale\(1\)/)
  await comparison.getByRole('button', { name: 'Close comparison' }).click()

  await ctrlDrag(page, imageNodes(page).first(), group)
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)

  const loose = await nodeBox(imageNodes(page).first())
  const setBox = await nodeBox(group)
  await page.mouse.move(loose.x + 30, loose.y + 30)
  await page.mouse.down()
  await page.mouse.move(setBox.x + 40, setBox.y + 40, { steps: 8 })
  await expect(page.getByRole('status')).toHaveText(
    'Release to add or move into this set'
  )
  await expect(group).toHaveClass(/ring-green-500/)
  await page.mouse.up()
  await expect(imageNodes(page)).toHaveCount(0)
  await expect(group).toContainText('Pair · 3')

  const before = await nodeBox(group)
  await dragBy(page, group, 120, 70)
  await expect
    .poll(async () => (await nodeBox(group)).x)
    .toBeGreaterThan(before.x + 60)
  const moved = await nodeBox(group)

  await page.reload()
  group = page.locator('.react-flow__node-group')
  await expect(group).toHaveCount(1)
  const persisted = await nodeBox(group)
  expect(Math.abs(persisted.x - moved.x)).toBeLessThan(15)
  expect(Math.abs(persisted.y - moved.y)).toBeLessThan(15)

  await group.dblclick()
  await expect(imageNodes(page)).toHaveCount(3)
  await page.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } })
  await expect(page.locator('.react-flow__node-group')).toHaveCount(1)

  group = page.locator('.react-flow__node-group')
  await group.click()
  await page.getByTestId('toggle-inspector-shelf').click()
  await page.getByRole('button', { name: 'Dissolve set' }).click()
  await expect(page.locator('.react-flow__node-group')).toHaveCount(0)
  await expect(imageNodes(page)).toHaveCount(3)
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
})

test('dragging an unplaced Assets item onto a set places it and adds membership', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-drop-fixtures')
  await placeAssets(page, ['group-alpha.png', 'group-beta.png'])
  await autoArrangeCanvas(page)
  await page.keyboard.press('ControlOrMeta+0')
  await selectImageNodes(page, [0, 1])
  await page.getByTestId('dock-create-set').click()

  const group = page.locator('.react-flow__node-group')
  await expect(group).toHaveCount(1)
  await expect(imageNodes(page)).toHaveCount(0)

  await openAssetsShelf(page)
  await asset(page, 'group-gamma.png').dragTo(group)
  await expect(group).toContainText('3')
  await expect(imageNodes(page)).toHaveCount(0)

  await group.dblclick()
  await expect(imageNodes(page)).toHaveCount(3)
})

test('node resize and movement persist while Space drag pans instead of moving nodes', async ({
  page,
}) => {
  await openFixtureRepo(page, 'resize-fixtures')
  await placeAssets(page, ['resize-alpha.png'])
  const node = imageNodes(page).first()
  await node.click()

  const beforeResize = await nodeBox(node)
  const handle = page.locator('.react-flow__resize-control.handle').last()
  await expect(handle).toBeVisible()
  await dragBy(page, handle, 60, 40)
  await expect
    .poll(async () => (await nodeBox(node)).width)
    .toBeGreaterThan(beforeResize.width + 30)
  const resized = await nodeBox(node)

  await dragBy(page, node, 100, 60)
  const moved = await nodeBox(node)
  expect(moved.x).toBeGreaterThan(resized.x + 50)

  await page.reload()
  const restored = imageNodes(page).first()
  await expect(restored).toBeVisible()
  const restoredBox = await nodeBox(restored)
  expect(Math.abs(restoredBox.width - resized.width)).toBeLessThan(5)
  expect(Math.abs(restoredBox.x - moved.x)).toBeLessThan(15)

  await restored.click()
  const nodeTransform = await restored.evaluate(
    (element) => (element as HTMLElement).style.transform
  )
  const viewport = page.locator('.react-flow__viewport')
  const viewportTransform = await viewport.getAttribute('style')
  await page.keyboard.down('Space')
  await dragBy(page, restored, 120, 60)
  await page.keyboard.up('Space')
  await expect
    .poll(() =>
      restored.evaluate((element) => (element as HTMLElement).style.transform)
    )
    .toBe(nodeTransform)
  await expect(viewport).not.toHaveAttribute('style', viewportTransform ?? '')
})

test('set shortcut and undo/redo work without stealing text-input undo', async ({
  page,
}) => {
  await openFixtureRepo(page, 'shortcut-fixtures')
  await placeAssets(page, ['shortcut-alpha.png'])
  await imageNodes(page).first().click()
  await page.getByTestId('open-command-palette').click()
  const paletteSearch = page.getByRole('combobox', { name: 'Search commands' })
  await paletteSearch.fill('Create set')
  await expect(
    page.getByRole('option', { name: /Select at least two ungrouped/ })
  ).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')

  await dropAsset(page, 'shortcut-beta.png', { x: 360, y: 180 })
  await expect(imageNodes(page)).toHaveCount(2)
  await autoArrangeCanvas(page)
  await page.keyboard.press('ControlOrMeta+0')
  await selectImageNodes(page, [0, 1])
  await expect(page.getByTestId('dock-create-set')).toBeEnabled()

  await page.keyboard.press('Control+g')
  await expect(page.locator('.react-flow__node-group')).toHaveCount(1)
  await expect(imageNodes(page)).toHaveCount(0)

  await page.keyboard.press('Control+z')
  await expect(page.locator('.react-flow__node-group')).toHaveCount(0)
  await expect(imageNodes(page)).toHaveCount(2)

  await page.keyboard.press('Control+y')
  await expect(page.locator('.react-flow__node-group')).toHaveCount(1)

  await openAssetsShelf(page)
  const search = page.getByRole('textbox', { name: 'Search assets' })
  await search.fill('shortcut')
  await search.press('Control+z')
  await expect(page.locator('.react-flow__node-group')).toHaveCount(1)
})

test('file drop and canvas clipboard paste create placed assets and errors are dismissible', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openFixtureRepo(page, 'media-fixtures')

  await page.evaluate(() => {
    const encoded =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }))
    const canvas = document.querySelector<HTMLElement>(
      'main[aria-label="Canvas"]'
    )
    if (!canvas) throw new Error('Canvas not found')
    const rect = canvas.getBoundingClientRect()
    canvas.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      })
    )
  })

  await expect(asset(page, 'dropped.png')).toBeVisible()
  await expect(imageNodes(page)).toHaveCount(1)

  await imageNodes(page).first().click()
  await page.evaluate(async () => {
    const data =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    await navigator.clipboard.writeText(
      JSON.stringify({
        version: 1,
        media: [{ name: 'canvas-paste.png', data }],
      })
    )
  })
  await page.keyboard.press('Control+v')
  await expect(imageNodes(page)).toHaveCount(2)

  await asset(page, 'media-alpha.png').click()
  await page.keyboard.press('Control+Shift+c')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('canvas-paste.png')
  await page.keyboard.press('Control+v')
  await expect(asset(page, 'canvas-paste.png')).toBeVisible()

  await page.evaluate(() => navigator.clipboard.writeText('not Loom media'))
  await page.keyboard.press('Control+v')
  await expect(page.getByRole('alert')).toContainText(
    'Clipboard contains no media files'
  )
})
