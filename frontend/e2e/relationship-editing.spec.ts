import type { Page } from '@playwright/test'
import { reverseRelationshipMethodID } from './bindings'
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

async function createChain(page: Page) {
  await openFixtureRepo(page, 'group-fixtures')
  for (const [index, name] of [
    'group-alpha.png',
    'group-beta.png',
    'group-gamma.png',
  ].entries())
    await dropAsset(page, name, { x: 450 + index * 200, y: 200 })
  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 900, y: 600 } })
  await autoArrangeCanvas(page)
  const nodes = imageNodes(page)
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
}

test('undo reconciles edge selection before additive selection and delete', async ({
  page,
}) => {
  await createChain(page)
  await clickEdge(page, 'left', 1)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+k')
  await page
    .getByRole('combobox', { name: 'Search commands' })
    .fill('Reverse relationship')
  await expect(
    page.getByRole('option', { name: /Reverse relationship/ })
  ).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.keyboard.down('Shift')
  await clickEdge(page, 'left', 0)
  await page.keyboard.up('Shift')
  await expect(page.locator('.react-flow__edge.selected')).toHaveCount(1)
  await page.keyboard.press('Delete')
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
})

test('edge menu supports keyboard navigation and focus restoration', async ({
  page,
}, testInfo) => {
  await createChain(page)
  const edge = page.locator('.react-flow__edge').first()
  await edge.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu')
  const reverse = menu.getByRole('menuitem', { name: 'Reverse relationship' })
  const remove = menu.getByRole('menuitem', {
    name: 'Remove selected relationships',
  })
  await expect(reverse).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('keyboard-edge-menu.png') })
  await page.keyboard.press('End')
  await page.keyboard.press('Home')
  await expect(reverse).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(remove).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(edge).toBeFocused()
  await page.keyboard.press('Shift+F10')
  const originalLabel = await edge.getAttribute('aria-label')
  const relationshipId = await edge.getAttribute('data-id')
  expect(relationshipId).toBeTruthy()
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(edge).not.toHaveAttribute('aria-label', originalLabel ?? '')
  await expect(edge).toHaveAttribute('data-id', relationshipId ?? '')
  await expect(edge).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await expect(reverse).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await expect(
    page.locator(`.react-flow__edge[data-id="${relationshipId}"]`)
  ).toHaveCount(0)
  await expect(page.locator('[data-canvas-surface]')).toBeFocused()
})

test('edge menu dismisses on outside click and Tab', async ({ page }) => {
  await createChain(page)
  const edge = page.locator('.react-flow__edge').first()
  await edge.focus()
  await page.keyboard.press('Shift+F10')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(edge).not.toBeFocused()
  await edge.focus()
  await page.keyboard.press('Shift+F10')
  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 900, y: 600 } })
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(edge).not.toBeFocused()
})

test('reverse does not reclaim focus moved while the request is pending', async ({
  page,
}) => {
  await createChain(page)
  const edge = page.locator('.react-flow__edge').first()
  const originalLabel = await edge.getAttribute('aria-label')
  let releaseReverse: () => void = () => {}
  const reverseGate = new Promise<void>((resolve) => {
    releaseReverse = resolve
  })
  let reverseStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    reverseStarted = resolve
  })
  await page.route('**/wails/runtime', async (route) => {
    if (route.request().postData()?.includes(reverseRelationshipMethodID)) {
      reverseStarted()
      await reverseGate
    }
    await route.continue()
  })

  await edge.focus()
  await page.keyboard.press('Shift+F10')
  await page.keyboard.press('Enter')
  await started
  const inspector = page.getByTestId('toggle-inspector-shelf')
  await inspector.click()
  const pin = page
    .locator('aside[aria-label="Inspector"]')
    .getByTestId('pin-shelf-right')
  await expect(pin).toBeFocused()
  releaseReverse()
  await expect(edge).not.toHaveAttribute('aria-label', originalLabel ?? '')
  await expect(pin).toBeFocused()
})

for (const activation of ['pointer', 'keyboard'] as const) {
  test(`pointer-opened menu does not restore focus after ${activation} reverse`, async ({
    page,
  }) => {
    await createChain(page)
    const edge = page.locator('.react-flow__edge').first()
    const originalLabel = await edge.getAttribute('aria-label')
    await edge.focus()
    await clickEdge(page, 'right')
    if (activation === 'pointer')
      await page.getByRole('menuitem', { name: 'Reverse relationship' }).click()
    else await page.keyboard.press('Enter')
    await expect(edge).not.toHaveAttribute('aria-label', originalLabel ?? '')
    await expect(edge).not.toBeFocused()
  })
}

test('edge Delete does not run from inputs, dialogs, or Assets', async ({
  page,
}) => {
  await createChain(page)
  await clickEdge(page, 'left', 0)
  await page.getByTestId('toggle-assets-shelf').click()
  const search = page.locator('aside[aria-label="Assets"] input').first()
  await search.fill('abc')
  await search.press('Backspace')
  await expect(search).toHaveValue('ab')
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  await search.clear()
  await page
    .getByRole('listbox', { name: 'Assets' })
    .getByRole('option')
    .first()
    .focus()
  await page.keyboard.press('Delete')
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  await page.keyboard.press('ControlOrMeta+k')
  await expect(
    page.getByRole('dialog', { name: 'Command palette' })
  ).toBeVisible()
  await page.getByRole('dialog', { name: 'Command palette' }).focus()
  await page.keyboard.press('Delete')
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
})

test('top-left resize undo and redo restore position and size', async ({
  page,
}) => {
  await openFixtureRepo(page, 'resize-fixtures')
  await dropAsset(page, 'resize-alpha.png', { x: 500, y: 180 })
  const node = imageNodes(page).first()
  await node.click()
  const before = await node.boundingBox()
  const handle = await node
    .locator('.react-flow__resize-control.handle.top.left')
    .boundingBox()
  if (!before || !handle) throw new Error('missing resize target')
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(handle.x - 80, handle.y - 60, { steps: 5 })
  await page.mouse.up()
  await expect
    .poll(async () => (await node.boundingBox())?.width ?? 0)
    .toBeGreaterThan(before.width + 30)
  const after = await node.boundingBox()
  if (!after) throw new Error('missing resized node')
  expect(after.x).toBeLessThan(before.x - 20)
  expect(after.y).toBeLessThan(before.y - 20)
  const geometry = async () => {
    const box = await node.boundingBox()
    if (!box) throw new Error('missing node')
    return [box.x, box.y, box.width, box.height].map(Math.round)
  }
  await page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(geometry)
    .toEqual([before.x, before.y, before.width, before.height].map(Math.round))
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect
    .poll(geometry)
    .toEqual([after.x, after.y, after.width, after.height].map(Math.round))
})

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
    menu.getByRole('menuitem', { name: 'Reverse relationship' })
  ).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('edge-menu.png') })
  await menu.getByRole('menuitem', { name: 'Reverse relationship' }).click()
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
