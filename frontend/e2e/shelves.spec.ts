import { expect, test } from './test-fixtures'
import { dropAsset, openFixtureRepo } from './test-helpers'

test.describe('floating Canvas drawers', () => {
  test('starts closed and never changes the full-viewport Canvas bounds', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openFixtureRepo(page, 'shelves-fixtures', { drawers: 'closed' })

    const canvas = page.getByRole('main', { name: 'Canvas' })
    const assets = page.locator('aside[aria-label="Assets"]')
    const inspector = page.locator('aside[aria-label="Inspector"]')
    await expect(assets).toHaveAttribute('data-state', 'closed')
    await expect(inspector).toHaveAttribute('data-state', 'closed')
    await expect(page.getByTestId('toggle-assets-shelf')).toHaveAttribute(
      'aria-expanded',
      'false'
    )

    const originalBounds = await canvas.boundingBox()
    expect(originalBounds).toMatchObject({
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
    })
    await page.getByTestId('shelf-edge-trigger-left').click()
    await expect(assets).toHaveAttribute('data-state', 'open')
    await page.getByTestId('toggle-inspector-shelf').click()
    await expect(inspector).toHaveAttribute('data-state', 'open')
    await expect(assets).toHaveAttribute('data-visible', 'true')

    const resizedBounds = await canvas.boundingBox()
    expect(resizedBounds).toEqual(originalBounds)
    await page.getByTestId('shelf-resize-handle-left').focus()
    await page.keyboard.press('End')
    await expect(page.getByTestId('shelf-resize-handle-left')).toHaveAttribute(
      'aria-valuenow',
      '480'
    )
    expect(await canvas.boundingBox()).toEqual(originalBounds)
  })

  test('supports edge, shortcut, pin, and successful-drop auto-hide paths', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openFixtureRepo(page, 'dock-fixtures', { drawers: 'closed' })
    const assets = page.locator('aside[aria-label="Assets"]')

    await page.getByTestId('shelf-edge-trigger-left').click()
    await expect(assets).toHaveAttribute('data-state', 'open')
    await page.keyboard.press('ControlOrMeta+b')
    await expect(assets).toHaveAttribute('data-state', 'closed')
    await page.keyboard.press('ControlOrMeta+b')
    await expect(assets).toHaveAttribute('data-state', 'open')

    await page.getByTestId('pin-shelf-left').click()
    await expect(page.getByTestId('pin-shelf-left')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await dropAsset(page, 'dock-alpha.png', { x: 420, y: 180 })
    await expect(assets).toHaveAttribute('data-state', 'open')
    await page.getByTestId('pin-shelf-left').click()
    await expect(page.getByTestId('pin-shelf-left')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    await dropAsset(page, 'dock-beta.png', { x: 640, y: 180 })
    await expect(assets).toHaveAttribute('data-state', 'closed')
  })

  test('auto-hides the unpinned Inspector when Canvas selection clears', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openFixtureRepo(page, 'dock-fixtures', { drawers: 'closed' })
    const inspector = page.locator('aside[aria-label="Inspector"]')

    await dropAsset(page, 'dock-alpha.png', { x: 420, y: 180 })
    await page.getByTestId('toggle-inspector-shelf').click()
    await expect(inspector).toHaveAttribute('data-state', 'open')
    await page
      .locator('.react-flow__pane')
      .click({ position: { x: 700, y: 460 } })
    await expect(inspector).toHaveAttribute('data-state', 'closed')

    await page.getByTestId('toggle-inspector-shelf').click()
    await page.getByTestId('pin-shelf-right').click()
    await page
      .locator('.react-flow__pane')
      .click({ position: { x: 700, y: 460 } })
    await expect(inspector).toHaveAttribute('data-state', 'open')
  })

  test('keeps closed drawer controls out of keyboard focus and remains usable on narrow screens', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 780 })
    await openFixtureRepo(page, 'responsive-fixtures', { drawers: 'closed' })
    const canvas = page.getByRole('main', { name: 'Canvas' })
    const assets = page.locator('aside[aria-label="Assets"]')

    await expect(assets).toHaveAttribute('inert', '')
    await page.getByTestId('toggle-assets-shelf').click()
    await expect(assets).toHaveAttribute('data-visible', 'true')
    await expect(assets).toHaveCSS('position', 'absolute')
    await expect
      .poll(async () => (await assets.boundingBox())?.width ?? 0)
      .toBeLessThanOrEqual(366)
    const fullBounds = await canvas.boundingBox()
    expect(fullBounds?.width).toBe(390)

    await page.getByTestId('toggle-inspector-shelf').click()
    await expect(assets).toHaveAttribute('data-state', 'closed')
    await expect(page.locator('aside[aria-label="Inspector"]')).toHaveAttribute(
      'data-state',
      'open'
    )
    expect((await canvas.boundingBox())?.width).toBe(390)
  })
})
