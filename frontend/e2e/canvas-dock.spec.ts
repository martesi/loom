import type { Locator } from '@playwright/test'
import { expect, test } from './test-fixtures'
import {
  dropAsset,
  imageNodes,
  nodeBox,
  openFixtureRepo,
  placeAssets,
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

    await placeAssets(page, ['dock-alpha.png', 'dock-beta.png'])
    await selectImageNodes(page, [0, 1])
    await expect(dock).toHaveAttribute('data-mode', 'multiple')
    await expect(dock).toHaveAttribute('data-selection-count', '2')
    await expect(page.getByTestId('dock-fit-all')).toHaveCount(0)
    await expect(page.getByTestId('dock-create-set')).toBeEnabled()
    await expect(page.getByTestId('dock-align-horizontal')).toBeVisible()

    const buttons = dock.getByRole('button')
    for (let index = 0; index < (await buttons.count()); index += 1) {
      const box = await buttons.nth(index).boundingBox()
      expect(box).not.toBeNull()
      if (box) {
        expect(box.height).toBeGreaterThanOrEqual(32)
        expect(box.width).toBeGreaterThanOrEqual(32)
      }
    }

    await page
      .locator('.react-flow__pane')
      .click({ position: { x: 600, y: 400 } })
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0)
    await expect(dock).toHaveAttribute('data-mode', 'idle')

    await selectImageNodes(page, [0])
    await expect(dock).toHaveAttribute('data-mode', 'single')
    await expect(page.getByTestId('dock-preview')).toBeVisible()
    await expect(page.getByTestId('dock-locate')).toBeVisible()
    await expect(page.getByTestId('dock-inspect')).toBeVisible()
    await expect(page.getByTestId('dock-create-set')).toHaveCount(0)

    await page.keyboard.press('ControlOrMeta+0')
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1)
  })

  test('single-selection preview and locate actions stay available in the dock', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-rel-fixtures', { drawers: 'closed' })
    await placeAssets(page, ['rel-alpha.png', 'rel-beta.png'])
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

  test('Align Horizontally and Vertically actions work accurately', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-arrange-fixtures', { drawers: 'closed' })
    await placeAssets(page, ['arrange-alpha.png', 'arrange-beta.png'])
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

  test('Create Set and Unplace actions work properly', async ({ page }) => {
    await openFixtureRepo(page, 'dock-group-fixtures', { drawers: 'closed' })
    await placeAssets(page, ['group-alpha.png', 'group-beta.png'])
    await selectImageNodes(page, [0, 1])
    await page.getByTestId('dock-create-set').click()

    await expect(page.locator('.react-flow__node-group')).toHaveCount(1)
    await page.locator('.react-flow__node-group').click()
    await expect(page.getByTestId('dock-unplace')).toBeVisible()
    await page.getByTestId('dock-unplace').click()
    await expect(page.locator('.react-flow__node-group')).toHaveCount(0)
  })

  test('keeps selection actions in the dock instead of attaching a toolbar to moving nodes', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-resize-fixtures', { drawers: 'closed' })
    await dropAsset(page, 'resize-alpha.png', { x: 900, y: 10 })
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
    await page.mouse.wheel(0, -300)
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
    await placeAssets(page, ['shortcut-alpha.png', 'shortcut-beta.png'])

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
})
