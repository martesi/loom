import { expect, type Locator, type Page, test } from '@playwright/test'
import {
  asset,
  ctrlDrag,
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
  await page.getByRole('button', { name: 'Auto-arrange' }).click()
  await page.getByRole('button', { name: 'Reset 100%' }).click()

  const nodes = imageNodes(page)
  await ctrlDrag(page, nodes.nth(0), nodes.nth(1))
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)

  await ctrlDrag(page, nodes.nth(1), nodes.nth(0))
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)

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
  await page.keyboard.press('Delete')
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
})

test('sets persist metadata and movement, accept source links, expand, and dissolve', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures')
  await placeAssets(page, [
    'group-alpha.png',
    'group-beta.png',
    'group-gamma.png',
  ])
  await page.getByRole('button', { name: 'Auto-arrange' }).click()
  await page.getByRole('button', { name: 'Reset 100%' }).click()
  await selectImageNodes(page, [0, 1])
  await page.getByRole('button', { name: 'Create set' }).click()

  let group = page.locator('.react-flow__node-group')
  await expect(group).toHaveCount(1)
  await expect(imageNodes(page)).toHaveCount(1)

  await group.click()
  const name = page.getByLabel('Set name')
  await name.fill('Pair')
  await name.blur()
  const kind = page.getByLabel('Kind')
  await kind.fill('variant')
  await kind.blur()
  await expect(group).toContainText('Pair · 2')

  await ctrlDrag(page, imageNodes(page).first(), group)
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)

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
  await page.getByRole('button', { name: 'Dissolve set' }).click()
  await expect(page.locator('.react-flow__node-group')).toHaveCount(0)
  await expect(imageNodes(page)).toHaveCount(3)
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
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
  const nodeTransform = await restored.getAttribute('style')
  const viewport = page.locator('.react-flow__viewport')
  const viewportTransform = await viewport.getAttribute('style')
  await page.keyboard.down('Space')
  await dragBy(page, restored, 120, 60)
  await page.keyboard.up('Space')
  await expect(restored).toHaveAttribute('style', nodeTransform ?? '')
  await expect(viewport).not.toHaveAttribute('style', viewportTransform ?? '')
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
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('converted copy is unavailable')
  await alert.getByRole('button', { name: 'Dismiss' }).click()
  await expect(alert).toHaveCount(0)

  await page.evaluate(() => navigator.clipboard.writeText('not Loom media'))
  await page.keyboard.press('Control+v')
  await expect(page.getByRole('alert')).toContainText(
    'Clipboard contains no media files'
  )
})
