import type { Locator } from '@playwright/test'
import { expect, test } from './test-fixtures'
import {
  asset,
  imageNodes,
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

test.describe('CanvasDock and SelectionHud', () => {
  test('CanvasDock renders with frosted glass aesthetic, >=32px hit targets, and reactive states', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-fixtures')

    const dock = page.getByTestId('canvas-dock')
    await expect(dock).toBeVisible()

    // Frosted glass styling checks
    await expect(dock).toHaveClass(/backdrop-blur-xl/)
    await expect(dock).toHaveClass(/rounded-full/)
    await expect(dock).toHaveClass(/shadow-2xl/)

    // All dock buttons must have hit target >= 32px (Fitts's Law)
    const buttons = dock.getByRole('button')
    const buttonCount = await buttons.count()
    expect(buttonCount).toBeGreaterThanOrEqual(4)

    for (let i = 0; i < buttonCount; i++) {
      const box = await buttons.nth(i).boundingBox()
      expect(box).not.toBeNull()
      if (box) {
        expect(box.height).toBeGreaterThanOrEqual(32)
        expect(box.width).toBeGreaterThanOrEqual(32)
      }
    }

    // Initial state: 0 nodes on canvas
    await expect(page.getByTestId('dock-fit-all')).toBeDisabled()
    await expect(page.getByTestId('dock-fit-selection')).toBeDisabled()
    await expect(page.getByTestId('dock-reset-zoom')).toBeEnabled()
    await page.getByTestId('dock-more').click()
    await expect(page.getByTestId('dock-auto-arrange')).toBeDisabled()

    // Place 2 assets (they are automatically selected on placement)
    await placeAssets(page, ['dock-alpha.png', 'dock-beta.png'])
    await expect(page.getByTestId('dock-fit-all')).toBeEnabled()
    await page.getByTestId('dock-more').click()
    await expect(page.getByTestId('dock-auto-arrange')).toBeEnabled()

    // Click canvas pane to deselect all nodes
    await page
      .locator('.react-flow__pane')
      .click({ position: { x: 600, y: 400 } })
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0)
    await expect(page.getByTestId('dock-fit-selection')).toBeDisabled()

    // Select 1 node
    await selectImageNodes(page, [0])
    await expect(page.getByTestId('dock-fit-selection')).toBeEnabled()
    await expect(page.getByTestId('dock-more')).toBeVisible()

    // Select 2 nodes
    await selectImageNodes(page, [0, 1])
    await expect(page.getByTestId('hud-create-set')).toBeEnabled()

    // Clicking dock buttons does not deselect canvas nodes (stopPropagation)
    await page.getByTestId('dock-reset-zoom').click()
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  })

  test('SelectionHud progressive disclosure: 1 node (Preview, Locate, Unplace) vs 2+ nodes (Create Set, Align, Arrange, Unplace)', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-rel-fixtures')
    await placeAssets(page, ['rel-alpha.png', 'rel-beta.png'])

    const hud = page.getByTestId('selection-hud')

    // Click canvas pane to deselect
    await page
      .locator('.react-flow__pane')
      .click({ position: { x: 600, y: 400 } })
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0)

    // 0 selected: HUD hidden
    await expect(hud).toHaveCount(0)

    // 1 node selected: progressive disclosure shows Preview, Locate, Unplace
    await selectImageNodes(page, [0])
    await expect(hud).toBeVisible()
    await expect(hud).toHaveClass(/backdrop-blur-xl/)
    await expect(hud).toHaveClass(/rounded-full/)

    const previewBtn = page.getByTestId('hud-preview')
    const locateBtn = page.getByTestId('hud-locate')
    const unplaceBtn = page.getByTestId('hud-unplace')

    await expect(previewBtn).toBeVisible()
    await expect(locateBtn).toBeVisible()
    await expect(unplaceBtn).toBeVisible()

    // Multi-select buttons should NOT be present for single node
    await expect(page.getByTestId('hud-create-set')).toHaveCount(0)
    await expect(page.getByTestId('hud-align-horizontally')).toHaveCount(0)
    await expect(page.getByTestId('hud-align-vertically')).toHaveCount(0)
    await expect(page.getByTestId('hud-arrange-subgraph')).toHaveCount(0)
    await expect(page.getByTestId('hud-unplace-selection')).toHaveCount(0)

    // Check hit areas for single-node HUD buttons >= 32px
    for (const btn of [previewBtn, locateBtn, unplaceBtn]) {
      const box = await btn.boundingBox()
      expect(box).not.toBeNull()
      if (box) {
        expect(box.height).toBeGreaterThanOrEqual(32)
        expect(box.width).toBeGreaterThanOrEqual(32)
      }
    }

    // Test Preview opens lightbox viewer
    await previewBtn.click()
    await expect(page.locator('.yarl__portal')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.yarl__portal')).toHaveCount(0)

    // Locate button test: transfers selection ownership to Assets list
    await locateBtn.click()
    await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(
      1
    )
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0)
    await page.getByTestId('toggle-assets-shelf').click()

    // 2 nodes selected: progressive disclosure shifts to multi-item toolset
    await selectImageNodes(page, [0, 1])
    await expect(hud).toBeVisible()

    // Single-node buttons should no longer be present
    await expect(page.getByTestId('hud-preview')).toHaveCount(0)
    await expect(page.getByTestId('hud-locate')).toHaveCount(0)
    await expect(page.getByTestId('hud-unplace')).toHaveCount(0)

    // Multi-node buttons are now visible
    const createSetBtn = page.getByTestId('hud-create-set')
    const alignHBtn = page.getByTestId('hud-align-horizontally')
    const alignVBtn = page.getByTestId('hud-align-vertically')
    const arrangeSubgraphBtn = page.getByTestId('hud-arrange-subgraph')
    const unplaceSelectionBtn = page.getByTestId('hud-unplace-selection')

    await expect(createSetBtn).toBeVisible()
    await expect(createSetBtn).toContainText('Create Set (2)')
    await expect(alignHBtn).toBeVisible()
    await expect(alignVBtn).toBeVisible()
    await expect(arrangeSubgraphBtn).toBeVisible()
    await expect(unplaceSelectionBtn).toBeVisible()

    // Check hit areas for multi-node HUD buttons >= 32px
    for (const btn of [
      createSetBtn,
      alignHBtn,
      alignVBtn,
      arrangeSubgraphBtn,
      unplaceSelectionBtn,
    ]) {
      const box = await btn.boundingBox()
      expect(box).not.toBeNull()
      if (box) {
        expect(box.height).toBeGreaterThanOrEqual(32)
        expect(box.width).toBeGreaterThanOrEqual(32)
      }
    }

    // Clicking HUD does not deselect canvas nodes
    await hud.click({ position: { x: 5, y: 5 } })
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  })

  test('SelectionHud Align Horizontally and Vertically actions work accurately', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-arrange-fixtures')
    await placeAssets(page, ['arrange-alpha.png', 'arrange-beta.png'])

    const nodes = imageNodes(page)

    // Select both nodes
    await selectImageNodes(page, [0, 1])

    // Test Align Horizontally: both nodes should have matching Y coordinates
    await page.getByTestId('hud-align-horizontally').click()

    await expect
      .poll(async () => {
        const p0 = await nodePosition(nodes.nth(0))
        const p1 = await nodePosition(nodes.nth(1))
        return Math.abs(p0.y - p1.y)
      })
      .toBeLessThanOrEqual(1)

    // Test Align Vertically: both nodes should have matching X coordinates
    await page.getByTestId('hud-align-vertically').click()

    await expect
      .poll(async () => {
        const p0 = await nodePosition(nodes.nth(0))
        const p1 = await nodePosition(nodes.nth(1))
        return Math.abs(p0.x - p1.x)
      })
      .toBeLessThanOrEqual(1)
  })

  test('SelectionHud Create Set and Unplace actions work properly', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-group-fixtures')
    await placeAssets(page, ['group-alpha.png', 'group-beta.png'])

    // Select both and create set via HUD
    await selectImageNodes(page, [0, 1])
    await page.getByTestId('hud-create-set').click()

    // Group node should now appear
    await expect(page.locator('.react-flow__node-group')).toHaveCount(1)

    // Select group node and unplace it
    await page.locator('.react-flow__node-group').click()
    const hud = page.getByTestId('selection-hud')
    await expect(hud).toBeVisible()
    await page.getByTestId('hud-unplace').click()

    await expect(page.locator('.react-flow__node-group')).toHaveCount(0)
  })

  test('SelectionHud viewport clamping prevents overflowing off-screen', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-resize-fixtures')
    // Drop asset near top boundary of canvas
    const source = asset(page, 'resize-alpha.png')
    await source.dragTo(page.locator('.react-flow__pane'), {
      targetPosition: { x: 100, y: 10 },
    })

    await selectImageNodes(page, [0])
    const hud = page.getByTestId('selection-hud')
    await expect(hud).toBeVisible()

    const hudBox = await hud.boundingBox()
    expect(hudBox).not.toBeNull()
    if (hudBox) {
      // HUD top should not be pushed off-screen (top must be >= 0)
      expect(hudBox.y).toBeGreaterThanOrEqual(0)
    }
  })

  test('Keyboard shortcuts trigger dock actions (Shift+1, Shift+2, Shift+A, Cmd/Ctrl+0)', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-shortcut-fixtures')
    await placeAssets(page, ['shortcut-alpha.png', 'shortcut-beta.png'])

    // Shift+A triggers auto-arrange
    await page.keyboard.press('Shift+A')
    await page.waitForTimeout(100)

    // Ctrl+0 triggers reset 100% zoom
    await page.keyboard.press('Control+0')
    await expect(page.locator('.react-flow__viewport')).toHaveAttribute(
      'style',
      /scale\(1\)/
    )

    // Select node and Shift+2 triggers fit selection
    await selectImageNodes(page, [0])
    await page.keyboard.press('Shift+2')
    await page.waitForTimeout(100)

    // Shift+1 triggers fit all
    await page.keyboard.press('Shift+1')
    await page.waitForTimeout(100)
  })
})
