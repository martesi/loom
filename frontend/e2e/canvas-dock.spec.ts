import type { Locator } from '@playwright/test'
import { expect, test } from './test-fixtures'
import {
  emptyCanvasPoint,
  enterEdit,
  imageNodes,
  moveImageNode,
  nodeBox,
  openFixtureRepo,
  selectImageNodes,
} from './test-helpers'

async function nodePosition(node: Locator) {
  const transform = await node.evaluate(
    (el) => (el as HTMLElement).style.transform
  )
  const match = transform.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/)
  if (!match) throw new Error(`missing node transform: ${transform}`)
  return { x: Number(match[1]), y: Number(match[2]) }
}

test.describe('contextual Canvas Dock', () => {
  test('morphs by selection and preserves canvas selection when used', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-fixtures', { drawers: 'closed' })

    const dock = page.getByTestId('canvas-dock')
    await expect(dock).toBeVisible()
    await expect(dock).toHaveAttribute('data-mode', 'idle')
    await expect(dock).toHaveClass(/backdrop-blur-xl/)
    await expect(dock).toHaveClass(/rounded-full/)
    await expect(dock).toHaveClass(/shadow-2xl/)
    await expect(page.getByTestId('dock-fit-all')).toBeDisabled()
    await expect(page.getByTestId('dock-fit-selection')).toBeDisabled()
    await expect(page.getByTestId('dock-reset-zoom')).toBeEnabled()
    await expect(page.getByTestId('dock-auto-arrange')).toBeDisabled()

    await enterEdit(page)
    await expect(imageNodes(page)).toHaveCount(2)
    await selectImageNodes(page, [0, 1])
    await expect(dock).toHaveAttribute('data-mode', 'multiple')
    await expect(dock).toHaveAttribute('data-selection-count', '2')
    await expect(page.getByTestId('dock-fit-all')).toHaveCount(0)
    await expect(page.getByTestId('dock-create-set')).toHaveCount(0)
    await expect(page.getByTestId('dock-align-horizontal')).toBeVisible()
    await expect(page.getByTestId('dock-auto-arrange')).toBeEnabled()

    const buttons = dock.getByRole('button')
    for (let index = 0; index < (await buttons.count()); index += 1) {
      const box = await buttons.nth(index).boundingBox()
      expect(box).not.toBeNull()
      if (box) {
        expect(box.height).toBeGreaterThanOrEqual(32)
        expect(box.width).toBeGreaterThanOrEqual(32)
      }
    }

    const empty = await emptyCanvasPoint(page)
    await page.mouse.click(empty.x, empty.y)
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0)
    await expect(dock).toHaveAttribute('data-mode', 'idle')

    await selectImageNodes(page, [0])
    await expect(dock).toHaveAttribute('data-mode', 'single')
    await expect(page.getByTestId('dock-preview')).toBeVisible()
    await expect(page.getByTestId('dock-locate')).toBeVisible()
    await expect(page.getByTestId('dock-inspect')).toBeVisible()
    await expect(page.getByTestId('dock-auto-arrange')).toBeEnabled()
    await expect(page.getByTestId('dock-create-set')).toHaveCount(0)

    await page.keyboard.press('ControlOrMeta+0')
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1)
  })

  test('single-selection preview and locate actions stay available in the dock', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-rel-fixtures', { drawers: 'closed' })
    await enterEdit(page)
    await expect(imageNodes(page)).toHaveCount(2)
    await selectImageNodes(page, [0])

    await page.getByTestId('dock-preview').click()
    await expect(page.locator('.yarl__portal')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.yarl__portal')).toHaveCount(0)

    await page.getByTestId('dock-locate').click()
    await expect(page.locator('aside[aria-label="Assets"]')).toHaveAttribute(
      'data-state',
      'open'
    )
    await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(
      1
    )
  })

  test('Space activates the focused Preview button and pans from the canvas background', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-fixtures', { drawers: 'closed' })
    await enterEdit(page)
    await expect(imageNodes(page)).toHaveCount(2)
    await selectImageNodes(page, [0])

    const preview = page.getByTestId('dock-preview')
    await page.getByRole('main', { name: 'Canvas' }).focus()
    for (let index = 0; index < 30; index += 1) {
      if (await preview.evaluate((button) => button === document.activeElement))
        break
      await page.keyboard.press('Tab')
    }
    await expect(preview).toBeFocused()
    await page.keyboard.press('Space')
    await expect(page.locator('.yarl__portal')).toBeVisible()
    await page.keyboard.press('Escape')

    await expect(page.getByRole('dialog', { name: 'Lightbox' })).toHaveCount(0)
    const empty = await emptyCanvasPoint(page)
    await page.mouse.click(empty.x, empty.y)
    await page.getByRole('main', { name: 'Canvas' }).focus()
    const viewport = page.locator('.react-flow__viewport')
    const beforePan = await viewport.getAttribute('style')
    await page.mouse.move(empty.x, empty.y)
    await page.keyboard.down('Space')
    await page.mouse.down()
    await page.mouse.move(empty.x + 80, empty.y + 60, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.up('Space')

    await expect.poll(() => viewport.getAttribute('style')).not.toBe(beforePan)
  })

  test('Align Horizontally and Vertically actions work accurately', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-rel-fixtures', { drawers: 'closed' })
    await enterEdit(page)
    await expect(imageNodes(page)).toHaveCount(2)
    const nodes = imageNodes(page)
    await selectImageNodes(page, [0, 1])

    await page.getByTestId('dock-align-horizontal').click()
    await expect
      .poll(async () => {
        const p0 = await nodePosition(nodes.nth(0))
        const p1 = await nodePosition(nodes.nth(1))
        return Math.abs(p0.y - p1.y)
      })
      .toBeLessThanOrEqual(1)

    await page.getByTestId('dock-align-vertical').click()
    await expect
      .poll(async () => {
        const p0 = await nodePosition(nodes.nth(0))
        const p1 = await nodePosition(nodes.nth(1))
        return Math.abs(p0.x - p1.x)
      })
      .toBeLessThanOrEqual(1)
  })

  test('multiple selection has no grouping or unplace actions', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-rel-fixtures', { drawers: 'closed' })
    await enterEdit(page)
    await expect(imageNodes(page)).toHaveCount(2)
    await selectImageNodes(page, [0, 1])
    await expect(page.getByTestId('dock-create-set')).toHaveCount(0)
    await expect(page.getByTestId('dock-unplace')).toHaveCount(0)
    await expect(page.locator('.react-flow__node-group')).toHaveCount(0)
    await expect(imageNodes(page)).toHaveCount(2)
  })

  test('keeps selection actions in the dock instead of attaching a toolbar to moving nodes', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-resize-fixtures', { drawers: 'closed' })
    await enterEdit(page)
    await expect(imageNodes(page)).toHaveCount(1)
    await selectImageNodes(page, [0])

    const dock = page.getByTestId('canvas-dock')
    const card = imageNodes(page).first().getByTestId('image-node-card')
    await expect(dock).toHaveAttribute('data-mode', 'single')
    await expect(page.getByTestId('selection-hud')).toHaveCount(0)

    const dockBefore = await dock.boundingBox()
    const cardBefore = await nodeBox(card)
    expect(dockBefore).not.toBeNull()
    expect(dockBefore?.y ?? 0).toBeGreaterThan(cardBefore.y)

    await page.mouse.move(600, 400)
    // Focus the canvas host so function keys reach the route handler.
    await page.getByRole('main', { name: 'Canvas' }).focus()
    // Ctrl+wheel zooms (proven pattern from the metadata zoom test; a single
    // tick is not reliably delivered as a zoom gesture in this harness).
    await page.keyboard.down('Control')
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 500)
    await page.keyboard.up('Control')
    await expect(dock).toBeVisible()
    expect(await dock.boundingBox()).toEqual(dockBefore)
    await expect
      .poll(async () => {
        const current = await nodeBox(card)
        return (
          Math.abs(current.x - cardBefore.x) +
          Math.abs(current.y - cardBefore.y)
        )
      })
      .toBeGreaterThan(1)
  })

  test('keyboard shortcuts trigger dock actions', async ({ page }) => {
    await openFixtureRepo(page, 'dock-shortcut-fixtures', { drawers: 'closed' })
    await enterEdit(page)
    await expect(imageNodes(page)).toHaveCount(2)
    await page.getByRole('main', { name: 'Canvas' }).focus()

    await page.keyboard.press('Shift+A')
    await page.keyboard.press('Control+0')
    await expect(page.locator('.react-flow__viewport')).toHaveAttribute(
      'style',
      /scale\(1\)/
    )

    await selectImageNodes(page, [0])
    await page.keyboard.press('Shift+2')
    await page.keyboard.press('Shift+1')
  })

  test('Shift+A arranges the whole canvas and undo restores it in one step', async ({
    page,
  }, testInfo) => {
    await openFixtureRepo(page, 'dock-arrange-fixtures', { drawers: 'closed' })
    await enterEdit(page)
    await expect(imageNodes(page)).toHaveCount(3)
    const nodes = imageNodes(page)
    await moveImageNode(page, nodes.nth(2), 100, 100)
    await selectImageNodes(page, [0, 1])
    const positions = async () =>
      Promise.all([0, 1, 2].map((index) => nodePosition(nodes.nth(index))))
    const before = await positions()
    await page.getByRole('main', { name: 'Canvas' }).focus()
    await page.keyboard.press('Shift+A')
    await expect.poll(async () => (await positions())[2]).not.toEqual(before[2])
    const after = await positions()
    await testInfo.attach('arranged-canvas', {
      body: await page.screenshot(),
      contentType: 'image/png',
    })
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(positions).toEqual(before)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(positions).toEqual(after)
  })
})
