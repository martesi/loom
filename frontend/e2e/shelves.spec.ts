import { expect, test } from '@playwright/test'
import { openFixtureRepo } from './test-helpers'

test.describe('ShelfPanel Drawer Architecture', () => {
  test('collapse and expand Assets shelf via collapse button, edge trigger, topbar button, and keyboard shortcut', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openFixtureRepo(page, 'shelves-fixtures')

    const assetsShelf = page.locator('aside[aria-label="Assets"]')
    const topbarBtn = page.getByTestId('toggle-assets-shelf')
    const collapseBtn = page.getByRole('button', {
      name: 'Collapse Assets shelf',
    })

    // Initially open on desktop
    await expect(assetsShelf).toHaveAttribute('data-state', 'open')
    await expect(topbarBtn).toHaveAttribute('aria-expanded', 'true')
    await expect(collapseBtn).toBeVisible()
    const initialBox = await assetsShelf.boundingBox()
    expect(initialBox?.width).toBeCloseTo(320, -1)

    // 1. Collapse via collapse button in shelf header
    await collapseBtn.click()
    await expect(assetsShelf).toHaveAttribute('data-state', 'closed')
    await expect(topbarBtn).toHaveAttribute('aria-expanded', 'false')
    await expect
      .poll(async () => (await assetsShelf.boundingBox())?.width ?? 0)
      .toBeLessThanOrEqual(1)

    // 2. Expand via floating edge trigger pinned at screen edge
    const edgeTrigger = page.getByTestId('shelf-edge-trigger-left')
    await expect(edgeTrigger).toBeVisible()
    await edgeTrigger.click()
    await expect(assetsShelf).toHaveAttribute('data-state', 'open')
    await expect(topbarBtn).toHaveAttribute('aria-expanded', 'true')
    await expect
      .poll(async () => (await assetsShelf.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(240)

    // 3. Collapse via topbar toggle button
    await topbarBtn.click()
    await expect(assetsShelf).toHaveAttribute('data-state', 'closed')
    await expect(topbarBtn).toHaveAttribute('aria-expanded', 'false')

    // 4. Expand via keyboard shortcut (Cmd/Ctrl+B)
    await page.keyboard.press('ControlOrMeta+b')
    await expect(assetsShelf).toHaveAttribute('data-state', 'open')
    await expect(topbarBtn).toHaveAttribute('aria-expanded', 'true')

    // 5. Collapse via keyboard shortcut (Cmd/Ctrl+B)
    await page.keyboard.press('ControlOrMeta+b')
    await expect(assetsShelf).toHaveAttribute('data-state', 'closed')
    await expect(topbarBtn).toHaveAttribute('aria-expanded', 'false')

    // 6. Keyboard shortcut guard: input elements must prevent shortcut toggle
    await page.keyboard.press('ControlOrMeta+b')
    await expect(assetsShelf).toHaveAttribute('data-state', 'open')
    await page.evaluate(() => {
      const input = document.createElement('input')
      input.id = 'shortcut-guard-input'
      document.body.appendChild(input)
      input.focus()
    })
    await page.keyboard.press('ControlOrMeta+b')
    // Remains open because active focus is on an input
    await expect(assetsShelf).toHaveAttribute('data-state', 'open')
    await page.evaluate(() => {
      document.getElementById('shortcut-guard-input')?.remove()
    })
  })

  test('collapse and expand Inspector shelf via collapse button, edge trigger, topbar button, and keyboard shortcut', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openFixtureRepo(page, 'shelves-inspector-fixtures')

    const inspectorShelf = page.locator('aside[aria-label="Inspector"]')
    const topbarBtn = page.getByTestId('toggle-inspector-shelf')
    const collapseBtn = page.getByRole('button', {
      name: 'Collapse Inspector shelf',
    })

    // Initially open on desktop
    await expect(inspectorShelf).toHaveAttribute('data-state', 'open')
    await expect(topbarBtn).toHaveAttribute('aria-expanded', 'true')
    await expect(collapseBtn).toBeVisible()
    const initialBox = await inspectorShelf.boundingBox()
    expect(initialBox?.width).toBeCloseTo(320, -1)

    // 1. Collapse via collapse button in shelf header
    await collapseBtn.click()
    await expect(inspectorShelf).toHaveAttribute('data-state', 'closed')
    await expect(topbarBtn).toHaveAttribute('aria-expanded', 'false')
    await expect
      .poll(async () => (await inspectorShelf.boundingBox())?.width ?? 0)
      .toBeLessThanOrEqual(1)

    // 2. Expand via floating edge trigger pinned at screen edge
    const edgeTrigger = page.getByTestId('shelf-edge-trigger-right')
    await expect(edgeTrigger).toBeVisible()
    await edgeTrigger.click()
    await expect(inspectorShelf).toHaveAttribute('data-state', 'open')
    await expect(topbarBtn).toHaveAttribute('aria-expanded', 'true')
    await expect
      .poll(async () => (await inspectorShelf.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(240)

    // 3. Collapse via topbar toggle button
    await topbarBtn.click()
    await expect(inspectorShelf).toHaveAttribute('data-state', 'closed')
    await expect(topbarBtn).toHaveAttribute('aria-expanded', 'false')

    // 4. Expand via keyboard shortcut (Cmd/Ctrl+I)
    await page.keyboard.press('ControlOrMeta+i')
    await expect(inspectorShelf).toHaveAttribute('data-state', 'open')
    await expect(topbarBtn).toHaveAttribute('aria-expanded', 'true')

    // 5. Collapse via keyboard shortcut (Cmd/Ctrl+I)
    await page.keyboard.press('ControlOrMeta+i')
    await expect(inspectorShelf).toHaveAttribute('data-state', 'closed')
    await expect(topbarBtn).toHaveAttribute('aria-expanded', 'false')

    // 6. Keyboard shortcut guard: input elements must prevent shortcut toggle
    await page.keyboard.press('ControlOrMeta+i')
    await expect(inspectorShelf).toHaveAttribute('data-state', 'open')
    await page.evaluate(() => {
      const input = document.createElement('input')
      input.id = 'shortcut-guard-input-inspector'
      document.body.appendChild(input)
      input.focus()
    })
    await page.keyboard.press('ControlOrMeta+i')
    // Remains open because active focus is on an input
    await expect(inspectorShelf).toHaveAttribute('data-state', 'open')
    await page.evaluate(() => {
      document.getElementById('shortcut-guard-input-inspector')?.remove()
    })
  })

  test('legacy single-letter 40px strip (A and I) is never rendered', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openFixtureRepo(page, 'direct-fixtures')

    // When shelves are open:
    await expect(
      page.getByRole('button', { name: 'A', exact: true })
    ).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'I', exact: true })
    ).toHaveCount(0)

    // Collapse both shelves
    await page.getByRole('button', { name: 'Collapse Assets shelf' }).click()
    await page.getByRole('button', { name: 'Collapse Inspector shelf' }).click()

    // When shelves are closed:
    await expect(
      page.getByRole('button', { name: 'A', exact: true })
    ).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'I', exact: true })
    ).toHaveCount(0)

    // Assert that no aside element has 40px width (legacy strip was 40px)
    const asides = page.locator('aside')
    const asideCount = await asides.count()
    for (let i = 0; i < asideCount; i++) {
      const box = await asides.nth(i).boundingBox()
      if (box) {
        expect(box.width).not.toBeCloseTo(40, -1)
      }
    }
  })

  test('shelf resizing respects min 240px and max 480px boundaries', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openFixtureRepo(page, 'shelves-resize-fixtures')

    const assetsShelf = page.locator('aside[aria-label="Assets"]')
    const handle = page.getByTestId('shelf-resize-handle-left')
    await expect(handle).toBeVisible()

    // Initial width is 320
    const initialBox = await assetsShelf.boundingBox()
    expect(initialBox?.width).toBeCloseTo(320, -1)

    // Drag handle past max limit (+300px from handle)
    const handleBox = await handle.boundingBox()
    expect(handleBox).not.toBeNull()
    if (handleBox) {
      await page.mouse.move(
        handleBox.x + handleBox.width / 2,
        handleBox.y + handleBox.height / 2
      )
      await page.mouse.down()
      await page.mouse.move(
        handleBox.x + 350,
        handleBox.y + handleBox.height / 2,
        { steps: 5 }
      )
      await page.mouse.up()
    }

    // Must be clamped to max 480px
    await expect
      .poll(async () => (await assetsShelf.boundingBox())?.width ?? 0)
      .toBeCloseTo(480, -1)

    // Drag handle past min limit (-400px from current handle)
    const currentHandleBox = await handle.boundingBox()
    expect(currentHandleBox).not.toBeNull()
    if (currentHandleBox) {
      await page.mouse.move(
        currentHandleBox.x + currentHandleBox.width / 2,
        currentHandleBox.y + currentHandleBox.height / 2
      )
      await page.mouse.down()
      await page.mouse.move(
        currentHandleBox.x - 400,
        currentHandleBox.y + currentHandleBox.height / 2,
        { steps: 5 }
      )
      await page.mouse.up()
    }

    // Must be clamped to min 240px
    await expect
      .poll(async () => (await assetsShelf.boundingBox())?.width ?? 0)
      .toBeCloseTo(240, -1)

    // Keyboard resizing via Arrow keys and Home/End
    await handle.focus()
    await page.keyboard.press('End')
    await expect
      .poll(async () => (await assetsShelf.boundingBox())?.width ?? 0)
      .toBeCloseTo(480, -1)

    await page.keyboard.press('Home')
    await expect
      .poll(async () => (await assetsShelf.boundingBox())?.width ?? 0)
      .toBeCloseTo(240, -1)

    await page.keyboard.press('ArrowRight') // +8px (8pt grid)
    await expect
      .poll(async () => (await assetsShelf.boundingBox())?.width ?? 0)
      .toBeCloseTo(248, -1)
  })

  test('compact viewport (< 1100px) displays shelves as floating overlays without shrinking canvas', async ({
    page,
  }) => {
    // Set compact viewport width < 1100px
    await page.setViewportSize({ width: 1024, height: 700 })
    await openFixtureRepo(page, 'responsive-fixtures')

    const canvas = page.getByRole('main', { name: 'Canvas' })
    const assetsShelf = page.locator('aside[aria-label="Assets"]')
    const inspectorShelf = page.locator('aside[aria-label="Inspector"]')

    // On compact viewports, shelves start closed
    await expect(assetsShelf).toHaveAttribute('data-state', 'closed')
    await expect(inspectorShelf).toHaveAttribute('data-state', 'closed')
    await expect
      .poll(async () => (await canvas.boundingBox())?.width)
      .toBe(1024)

    // Open Assets shelf in compact mode
    await page.getByTestId('toggle-assets-shelf').click()
    await expect(assetsShelf).toHaveAttribute('data-state', 'open')
    await expect(assetsShelf).toHaveCSS('position', 'absolute')

    // Canvas width must still be 1024 (overlay floating above canvas, not shrinking it)
    await expect
      .poll(async () => (await canvas.boundingBox())?.width)
      .toBe(1024)

    // Close Assets shelf
    await page.getByRole('button', { name: 'Collapse Assets shelf' }).click()
    await expect(assetsShelf).toHaveAttribute('data-state', 'closed')

    // Open Inspector shelf in compact mode
    await page.getByTestId('toggle-inspector-shelf').click()
    await expect(inspectorShelf).toHaveAttribute('data-state', 'open')
    await expect(inspectorShelf).toHaveCSS('position', 'absolute')

    // Canvas width still remains 1024
    await expect
      .poll(async () => (await canvas.boundingBox())?.width)
      .toBe(1024)

    // Expanding viewport to desktop (> 1100px) transitions shelves back to flex layout
    await page.setViewportSize({ width: 1400, height: 700 })
    await expect(inspectorShelf).toHaveCSS('position', 'relative')
    // In flex layout, canvas shares horizontal space with the open shelf
    await expect
      .poll(async () => (await canvas.boundingBox())?.width ?? 1400)
      .toBeLessThan(1400)
  })
})
