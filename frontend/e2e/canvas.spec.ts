import type { Page } from '@playwright/test'
import { expect, test } from './test-fixtures'
import {
  asset,
  assets,
  autoArrangeCanvas,
  imageNodes as canvasNodes,
  ctrlDrag,
  dropAsset,
  fixturePath,
  openFixtureRepo as open,
  openAssetsShelf,
  selectImageNodes,
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
test('Assets selection, placement, trash and viewport persistence', async ({
  page,
}) => {
  await open(page, 'canvas-fixtures')
  const repoPath = await fixturePath('canvas-fixtures')
  const editViewportKey = `loom.canvas.viewport.v1:${encodeURIComponent(repoPath)}:edit`
  await page.evaluate((key) => localStorage.removeItem(key), editViewportKey)
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
    page.getByText(
      'View shows images with relationships. Switch to Edit to stage and connect assets.'
    )
  ).toBeVisible()
  await expect(page.getByTestId('empty-canvas-edit')).toBeVisible()
  const rows = assets(page)
  await rows.first().click()
  await rows.last().click({ modifiers: ['Shift'] })
  await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(2)
  await page.getByRole('button', { name: 'Folders', exact: true }).click()
  await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(2)
  await page.getByRole('button', { name: 'All Assets', exact: true }).click()
  await page.getByTestId('empty-canvas-edit').click()
  await expect(page.getByTestId('canvas-mode-edit')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
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
  await expect(page.getByTestId('dock-unplace')).toHaveCount(0)
  await page.keyboard.press('Delete')
  await expect(page.locator('.react-flow__node')).toHaveCount(2)
  await openAssetsShelf(page)
  await expect(rows).toHaveCount(2)
  await rows.first().click()
  await page.keyboard.press('Delete')
  const assetTrashDialog = page.getByRole('dialog', {
    name: 'Move 1 asset to trash?',
  })
  await expect(assetTrashDialog).toBeVisible()
  await assetTrashDialog.getByRole('button', { name: 'Move to trash' }).click()
  await expect(rows).toHaveCount(1)
  await expect(page.locator('.react-flow__node')).toHaveCount(1)
  const viewport = page.locator('.react-flow__viewport')
  await page.keyboard.press('ControlOrMeta+Shift+1')
  await expect
    .poll(() =>
      page.evaluate((key) => localStorage.getItem(key), editViewportKey)
    )
    .not.toBeNull()
  const transform = await viewport.getAttribute('style')
  await page.reload()
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  await page.getByTestId('canvas-mode-edit').click()
  await expect(page.getByTestId('canvas-mode-edit')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
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
  await page.getByTestId('canvas-mode-edit').click()
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

  await selectImageNodes(page, [0, 1])
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
    paneMenu.getByRole('menuitem', { name: 'Select all', exact: true })
  ).toBeVisible()
  await expect(
    paneMenu.getByRole('menuitem', { name: 'Auto-arrange Canvas', exact: true })
  ).toBeVisible()
  await paneMenu
    .getByRole('menuitem', { name: 'Select all', exact: true })
    .click()
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  await nodes.first().click({ button: 'right' })
  const selectionMenu = page.getByRole('menu')
  await expect(
    selectionMenu.getByRole('menuitem', {
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
    nodeMenu.getByRole('menuitem', { name: 'Find in Assets', exact: true })
  ).toBeVisible()
  await expect(
    nodeMenu.getByRole('menuitem', { name: 'Remove from canvas', exact: true })
  ).toHaveCount(0)
  await expect(
    nodeMenu.getByRole('menuitem', { name: 'Archive' })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await openAssetsShelf(page)
  await expect(assets(page)).toHaveCount(2)
})

test('Auto-arrange Canvas stages orphans at the viewport center', async ({
  page,
}) => {
  await open(page, 'canvas-menu-actions-fixtures')
  await page.getByTestId('canvas-mode-edit').click()
  await drop(page, 'context-alpha.png', 280, 240)
  await drop(page, 'context-beta.png', 520, 420)
  await page.keyboard.press('ControlOrMeta+0')
  const nodes = canvasNodes(page)
  await expect(nodes).toHaveCount(2)
  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 850, y: 100 } })
  await page.getByTestId('dock-auto-arrange').click()

  const expected = await page
    .locator('.react-flow__viewport')
    .evaluate((element) => {
      const pane = element.closest('.react-flow')
      if (!pane) throw new Error('missing flow pane')
      const { width, height } = pane.getBoundingClientRect()
      const transform = getComputedStyle(element).transform
      const matrix = new DOMMatrixReadOnly(transform)
      return {
        x: (width / 2 - matrix.m41) / matrix.a,
        y: (height / 2 - matrix.m42) / matrix.d,
      }
    })
  const arranged = [
    await nodePosition(nodes.nth(0)),
    await nodePosition(nodes.nth(1)),
  ]
  const center = {
    x:
      (Math.min(...arranged.map((node) => node.x)) +
        Math.max(...arranged.map((node) => node.x + 150))) /
      2,
    y:
      (Math.min(...arranged.map((node) => node.y)) +
        Math.max(...arranged.map((node) => node.y + 110))) /
      2,
  }
  expect(center.x).toBeCloseTo(expected.x, 0)
  expect(center.y).toBeCloseTo(expected.y, 0)
})

test('explicit relationship gesture, navigation, and individual selection', async ({
  page,
}) => {
  await open(page, 'menu-linux-fixtures')
  await page.getByTestId('canvas-mode-edit').click()
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
  const inspector = page.locator('aside[aria-label="Inspector"]')
  if ((await inspector.getAttribute('data-state')) !== 'open')
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
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  await expect(page.getByTestId('dock-create-set')).toHaveCount(0)
  await expect(nodes).toHaveCount(2)
  await page.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } })
  await expect(page.locator('.react-flow__node-group')).toHaveCount(0)
  await page.locator('.react-flow__pane').click({
    button: 'right',
    position: { x: 10, y: 10 },
  })
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: 'Select all' })
    .click()
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
})
test('Select all excludes unplaced assets without hiding them from Assets', async ({
  page,
}) => {
  await open(page, 'partial-set-fixtures')
  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await asset(page, 'partial-alpha.png').dragTo(
    page.locator('.react-flow__pane'),
    { targetPosition: { x: 700, y: 300 } }
  )
  await expect(canvasNodes(page)).toHaveCount(0)
  await page.getByTestId('canvas-mode-edit').click()
  await expect(page.getByTestId('canvas-mode-edit')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(canvasNodes(page)).toHaveCount(2)
  await ctrlDrag(page, canvasNodes(page).nth(0), canvasNodes(page).nth(1))
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await page.locator('input[type=file]').setInputFiles({
    name: 'partial-unplaced.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    ),
  })
  await expect(canvasNodes(page)).toHaveCount(2)
  await page.getByTestId('canvas-mode-view').click()
  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(canvasNodes(page)).toHaveCount(2)
  await page.getByTestId('toggle-assets-shelf').click()
  await canvasNodes(page).first().click()
  await page.keyboard.press('Control+a')
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  await expect(page.locator('.react-flow__node-group')).toHaveCount(0)
  await page.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } })

  await page.locator('.react-flow__pane').click({
    button: 'right',
    position: { x: 10, y: 10 },
  })
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: 'Select all' })
    .click()
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  await page.getByTestId('toggle-assets-shelf').click()
  await expect(
    assets(page).filter({ hasText: 'partial-unplaced.png' })
  ).toBeVisible()
})
test('marquee selection replaces the Canvas selection', async ({ page }) => {
  await open(page, 'set-fixtures')
  await page.getByTestId('canvas-mode-edit').click()
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
  clipboardAccess,
}) => {
  void clipboardAccess
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
