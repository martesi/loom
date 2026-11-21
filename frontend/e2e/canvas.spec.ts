import type { Page } from '@playwright/test'
import { expect, test } from './test-fixtures'
import {
  assets,
  autoArrangeCanvas,
  imageNodes as canvasNodes,
  dropAsset,
  dropAssetRow,
  openFixtureRepo as open,
  openAssetsShelf,
} from './test-helpers'

async function drop(page: Page, name: string, x: number, y: number) {
  await dropAsset(page, name, { x, y })
}
async function nodePosition(node: ReturnType<Page['locator']>) {
  const transform = await node.evaluate(
    (element) => (element as HTMLElement).style.transform
  )
  const match = transform.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/)
  if (!match) throw new Error(`missing node transform: ${transform}`)
  return { x: Number(match[1]), y: Number(match[2]) }
}
test('Assets selection, placement, unplace, trash and viewport persistence', async ({
  page,
}) => {
  await open(page, 'canvas-fixtures')
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute(
    'style',
    /scale\(1\)/
  )
  await expect(
    page.getByRole('heading', { name: 'Start with an asset' })
  ).toBeVisible()
  await expect(
    page.getByText('Drag an asset from Assets onto the canvas.')
  ).toBeVisible()
  const rows = assets(page)
  await rows.first().click()
  await rows.last().click({ modifiers: ['Shift'] })
  await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(2)
  await page.getByRole('button', { name: 'Folders', exact: true }).click()
  await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(2)
  await page.getByRole('button', { name: 'All Assets', exact: true }).click()
  await drop(page, 'canvas-alpha.png', 80, 100)
  await expect(page.locator('.react-flow__node')).toHaveCount(2)
  await expect(
    page.getByRole('heading', { name: 'Start with an asset' })
  ).toHaveCount(0)
  await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(0)
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  await page.keyboard.press('Shift+2')
  await openAssetsShelf(page)
  await rows.first().click()
  await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(1)
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0)
  await canvasNodes(page).first().click()
  await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(0)
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1)
  await page.keyboard.press('Control+a')
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  await page.keyboard.press('ControlOrMeta+0')
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute(
    'style',
    /scale\(1\)/
  )
  await autoArrangeCanvas(page)
  await page.keyboard.press('Delete')
  // Canvas Delete is reversible unplace, not Assets trash.
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  await expect(rows).toHaveCount(2)
  await rows.first().click()
  await page.keyboard.press('Delete')
  const assetTrashDialog = page.getByRole('dialog', {
    name: 'Move 1 asset to trash?',
  })
  await expect(assetTrashDialog).toBeVisible()
  await assetTrashDialog.getByRole('button', { name: 'Move to trash' }).click()
  await expect(rows).toHaveCount(1)
  await dropAssetRow(page, rows.first(), { x: 90, y: 90 })
  await expect(page.locator('.react-flow__node')).toHaveCount(1)
  const viewport = page.locator('.react-flow__viewport')
  const viewportSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/wails/runtime') &&
      response.request().postData()?.includes('"methodID":248266558') === true
  )
  await page.keyboard.press('Shift+1')
  await viewportSaved
  const transform = await viewport.getAttribute('style')
  await page.reload()
  await expect(page.locator('.react-flow__node')).toHaveCount(1)
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute(
    'style',
    transform ?? ''
  )
})
test('canvas context menus and auto-arrange preserve the canvas origin', async ({
  page,
}) => {
  await open(page, 'canvas-menu-actions-fixtures')
  await drop(page, 'context-alpha.png', 280, 240)
  await drop(page, 'context-beta.png', 520, 420)
  await page.keyboard.press('ControlOrMeta+0')

  const nodes = canvasNodes(page)
  await expect(nodes).toHaveCount(2)
  const before = [
    await nodePosition(nodes.nth(0)),
    await nodePosition(nodes.nth(1)),
  ]
  const minBefore = {
    x: Math.min(...before.map((position) => position.x)),
    y: Math.min(...before.map((position) => position.y)),
  }

  await autoArrangeCanvas(page)
  await expect
    .poll(async () => {
      const after = [
        await nodePosition(nodes.nth(0)),
        await nodePosition(nodes.nth(1)),
      ]
      return Math.max(
        ...after.map(
          (position, index) =>
            Math.abs(position.x - before[index].x) +
            Math.abs(position.y - before[index].y)
        )
      )
    })
    .toBeGreaterThan(10)

  const after = [
    await nodePosition(nodes.nth(0)),
    await nodePosition(nodes.nth(1)),
  ]
  expect(Math.min(...after.map((position) => position.x))).toBeCloseTo(
    minBefore.x,
    3
  )
  expect(Math.min(...after.map((position) => position.y))).toBeCloseTo(
    minBefore.y,
    3
  )

  await page.locator('.react-flow__pane').click({
    button: 'right',
    position: { x: 850, y: 100 },
  })
  const paneMenu = page.getByRole('menu')
  await expect(paneMenu).toBeVisible()
  await expect(
    paneMenu.getByRole('button', { name: 'Select all', exact: true })
  ).toBeVisible()
  await expect(
    paneMenu.getByRole('button', { name: 'Auto-arrange Canvas', exact: true })
  ).toBeVisible()
  await paneMenu
    .getByRole('button', { name: 'Select all', exact: true })
    .click()
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  await nodes.first().click({ button: 'right' })
  const selectionMenu = page.getByRole('menu')
  await expect(
    selectionMenu.getByRole('button', {
      name: 'Auto-arrange selection',
      exact: true,
    })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 850, y: 100 } })

  await nodes.first().click({ button: 'right' })
  const nodeMenu = page.getByRole('menu')
  await expect(nodeMenu).toBeVisible()
  await expect(
    nodeMenu.getByRole('button', { name: 'Find in Assets', exact: true })
  ).toBeVisible()
  await expect(
    nodeMenu.getByRole('button', { name: 'Remove from canvas', exact: true })
  ).toBeVisible()
  await nodeMenu
    .getByRole('button', { name: 'Remove from canvas', exact: true })
    .click()
  await expect(nodes).toHaveCount(1)
  await page.getByTestId('toggle-inspector-shelf').click()
  await expect(
    page.getByRole('heading', { name: 'No Selection', exact: true })
  ).toBeVisible()
  await page.getByTestId('toggle-inspector-shelf').click()
  await openAssetsShelf(page)
  await expect(assets(page)).toHaveCount(2)

  await nodes.first().click({ button: 'right' })
  await page.getByRole('menu').getByRole('button', { name: 'Trash' }).click()
  const trashDialog = page.getByRole('dialog', {
    name: 'Move 1 asset to trash?',
  })
  await expect(trashDialog).toBeVisible()
  await trashDialog.getByRole('button', { name: 'Move to trash' }).click()
  await expect(nodes).toHaveCount(0)
  await expect(assets(page)).toHaveCount(1)
  await page.getByTestId('toggle-inspector-shelf').click()
  await expect(
    page.getByRole('heading', { name: 'No Selection', exact: true })
  ).toBeVisible()
})

test('explicit relationship gesture, navigation, and semantic sets', async ({
  page,
}) => {
  await open(page, 'menu-linux-fixtures')
  await drop(page, 'menu-alpha.png', 50, 100)
  await drop(page, 'menu-beta.png', 280, 200)
  await page.keyboard.press('ControlOrMeta+0')
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute(
    'style',
    /scale\(1\)/
  )
  const nodes = canvasNodes(page)
  await autoArrangeCanvas(page)
  await expect
    .poll(async () => {
      const first = await nodes.nth(0).boundingBox()
      const second = await nodes.nth(1).boundingBox()
      if (!first || !second) return false
      return (
        first.x + first.width <= second.x ||
        second.x + second.width <= first.x ||
        first.y + first.height <= second.y ||
        second.y + second.height <= first.y
      )
    })
    .toBe(true)
  await expect(nodes).toHaveCount(2)
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
  await expect(page.locator('.react-flow__handle:visible')).toHaveCount(0)
  const a = await nodes.nth(0).boundingBox(),
    b = await nodes.nth(1).boundingBox()
  if (!a || !b) throw new Error('missing nodes')
  await page.keyboard.down('Control')
  await page.mouse.move(a.x + 40, a.y + 40)
  await page.mouse.down()
  await page.mouse.move(b.x + 40, b.y + 40, { steps: 10 })
  await page.mouse.up()
  await page.keyboard.up('Control')
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  const source = await nodes.nth(0).boundingBox(),
    target = await nodes.nth(1).boundingBox()
  if (!source || !target) throw new Error('missing nodes')
  await page.keyboard.down('Control')
  await page.mouse.move(target.x + 40, target.y + 40)
  await page.mouse.down()
  await page.mouse.move(source.x + 40, source.y + 40, { steps: 10 })
  await page.mouse.up()
  await page.keyboard.up('Control')
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await nodes.nth(0).click()
  await page.getByTestId('toggle-inspector-shelf').click()
  await expect(page.getByRole('heading', { name: 'Derived' })).toBeVisible()
  await page.getByRole('button', { name: /^Go to derived asset .+/ }).click()
  await expect(nodes.nth(1)).toHaveClass(/selected/)
  await page
    .getByRole('button', {
      name: 'Remove relationship with menu-alpha.png',
      exact: true,
    })
    .click()
  const removeRelationshipDialog = page.getByRole('dialog', {
    name: 'Remove relationship?',
  })
  await expect(removeRelationshipDialog).toBeVisible()
  await removeRelationshipDialog
    .getByRole('button', { name: 'Remove relationship', exact: true })
    .click()
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
  await page.keyboard.press('Control+a')
  await page.getByTestId('dock-create-set').click()
  await expect(page.locator('.react-flow__node-group')).toHaveCount(1)
  await page.locator('.react-flow__node-group').dblclick()
  await expect(nodes).toHaveCount(2)
  await page.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } })
  await expect(page.locator('.react-flow__node-group')).toHaveCount(1)
  await page.locator('.react-flow__pane').click({
    button: 'right',
    position: { x: 10, y: 10 },
  })
  await page
    .getByRole('menu')
    .getByRole('button', { name: 'Select all' })
    .click()
  await expect(page.locator('.react-flow__node-group.selected')).toHaveCount(1)
})
test('Select all highlights a set with an unplaced member', async ({
  page,
}) => {
  await open(page, 'partial-set-fixtures')
  await drop(page, 'partial-alpha.png', 80, 100)
  await drop(page, 'partial-beta.png', 280, 100)
  await expect(canvasNodes(page)).toHaveCount(2)
  await canvasNodes(page).first().click()
  await page.keyboard.press('Control+a')
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  await page.getByTestId('dock-create-set').click()

  const group = page.locator('.react-flow__node-group')
  await expect(group).toHaveCount(1)
  await group.dblclick()
  await expect(canvasNodes(page)).toHaveCount(2)
  await canvasNodes(page).first().click()
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1)
  await page.keyboard.press('Delete')
  await expect(canvasNodes(page)).toHaveCount(1)
  await page.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } })
  await expect(group).toHaveCount(1)

  await page.locator('.react-flow__pane').click({
    button: 'right',
    position: { x: 10, y: 10 },
  })
  await page
    .getByRole('menu')
    .getByRole('button', { name: 'Select all' })
    .click()
  await expect(group).toHaveClass(/selected/)
})
test('marquee selection replaces the Canvas selection', async ({ page }) => {
  await open(page, 'set-fixtures')
  await drop(page, 'set-alpha.png', 360, 100)
  await drop(page, 'set-beta.png', 580, 100)
  await drop(page, 'set-gamma.png', 820, 100)
  await page.keyboard.press('ControlOrMeta+0')
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute(
    'style',
    /scale\(1\)/
  )
  const nodes = canvasNodes(page)
  const first = await nodes.first().boundingBox(),
    second = await nodes.nth(1).boundingBox()
  if (!first || !second) throw new Error('missing nodes')
  await page.mouse.move(first.x - 10, first.y - 10)
  await page.mouse.down()
  await page.mouse.move(
    second.x + second.width + 10,
    second.y + second.height + 10,
    {
      steps: 8,
    }
  )
  await page.mouse.up()
  await expect(nodes).toHaveCount(3)
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
})
test('browser import creates an unplaced asset and keeps Canvas focused behavior separate', async ({
  page,
}) => {
  await open(page, 'clipboard-fixtures')
  await page.locator('input[type=file]').setInputFiles({
    name: 'imported.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    ),
  })
  await expect(assets(page)).toHaveCount(2)
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  await expect(
    assets(page).filter({ hasText: 'imported.png' })
  ).toHaveAttribute('aria-selected', 'true')
})
test('browser clipboard copies original media and paste creates fresh unplaced assets', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await open(page, 'filename-fixtures')
  await assets(page).filter({ hasText: 'hover-target.png' }).click()
  await page.keyboard.press('Control+c')
  await page.waitForTimeout(200)
  await page.keyboard.press('Control+v')
  await expect(page.locator('[data-asset-id]')).toHaveCount(2)
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  await expect(page.locator('[aria-selected=true]')).toHaveCount(1)
  await page.keyboard.press('Shift+Delete')
  const purgeDialog = page.getByRole('dialog', {
    name: 'Permanently delete 1 asset?',
  })
  await expect(purgeDialog).toBeVisible()
  await purgeDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(purgeDialog).toHaveCount(0)
  await expect(page.locator('[data-asset-id]')).toHaveCount(2)
  await assets(page).filter({ hasText: 'hover-target (1).png' }).click()
  await page.keyboard.press('Shift+Delete')
  await page
    .getByRole('dialog', { name: 'Permanently delete 1 asset?' })
    .getByRole('button', { name: 'Permanently delete' })
    .click()
  await expect(page.locator('[data-asset-id]')).toHaveCount(1)
})
