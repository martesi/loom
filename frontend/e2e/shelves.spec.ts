import { expect, test } from './test-fixtures'
import {
  asset,
  dropAsset,
  imageNodes,
  openFixtureRepo,
  placeAssets,
} from './test-helpers'

test.describe('floating Canvas drawers', () => {
  test('icon-only floating controls show framework tooltips with separate shortcut keys', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'shelves-fixtures', { drawers: 'closed' })
    await page.getByTestId('open-command-palette').hover()

    const tooltip = page.getByTestId('base-tooltip-popup')
    await expect(tooltip).toBeVisible()
    await expect(tooltip).toContainText('Show commands')
    const keys = tooltip.locator('[data-slot="kbd"]')
    await expect(keys).toHaveCount(2)
    await expect(keys.nth(0)).toHaveText('Ctrl')
    await expect(keys.nth(1)).toHaveText('K')
  })

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
    const assetsToggle = page.getByTestId('toggle-assets-shelf')
    const inspectorToggle = page.getByTestId('toggle-inspector-shelf')
    await expect(assetsToggle).toBeVisible()
    await expect(inspectorToggle).toBeVisible()
    await expect(page.getByTestId('shelf-edge-trigger-left')).toHaveCount(0)
    await expect(page.getByTestId('shelf-edge-trigger-right')).toHaveCount(0)

    const originalBounds = await canvas.boundingBox()
    expect(originalBounds).toMatchObject({
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
    })
    await assetsToggle.click()
    await expect(assets).toHaveAttribute('data-state', 'open')
    await inspectorToggle.click()
    await expect(inspector).toHaveAttribute('data-state', 'open')
    await expect(assetsToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(inspectorToggle).toHaveAttribute('aria-expanded', 'true')
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

  test('supports top-island, shortcut, pin, and successful-drop auto-hide paths', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openFixtureRepo(page, 'dock-fixtures', { drawers: 'closed' })
    const assets = page.locator('aside[aria-label="Assets"]')

    await page.getByTestId('toggle-assets-shelf').click()
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
    await expect(page.getByRole('main', { name: 'Canvas' })).toBeFocused()
  })

  test('Escape closes an unpinned drawer while focus is in its search field', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'library-fixtures', { drawers: 'assets' })
    const assets = page.locator('aside[aria-label="Assets"]')
    const search = page.getByRole('textbox', { name: 'Search assets' })
    const trigger = page.getByTestId('toggle-assets-shelf')

    await search.focus()
    await expect(search).toBeFocused()
    await page.keyboard.press('Escape')

    await expect(assets).toHaveAttribute('data-state', 'closed')
    await expect(trigger).toBeFocused()

    await trigger.click()
    await expect(assets).toHaveAttribute('data-state', 'open')
    await page.getByTestId('collapse-shelf-left').click()
    await expect(assets).toHaveAttribute('data-state', 'closed')
    await expect(trigger).toBeFocused()
  })

  test('Escape closes palette and menus before an unpinned drawer', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'library-fixtures', { drawers: 'assets' })
    const assets = page.locator('aside[aria-label="Assets"]')

    await asset(page, 'root-alpha.png').click()
    await page.keyboard.press('Shift+Delete')
    const purgeDialog = page.getByRole('dialog', {
      name: 'Permanently delete 1 asset?',
    })
    await expect(purgeDialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(purgeDialog).toHaveCount(0)
    await expect(assets).toHaveAttribute('data-state', 'open')

    await page.getByTestId('toggle-assets-shelf').focus()
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByTestId('command-palette')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('command-palette')).toHaveCount(0)
    await expect(assets).toHaveAttribute('data-state', 'open')

    await page.getByTestId('repository-actions').click()
    await expect(
      page.getByRole('menu', { name: 'Repository actions' })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(
      page.getByRole('menu', { name: 'Repository actions' })
    ).toHaveCount(0)
    await expect(assets).toHaveAttribute('data-state', 'open')

    await asset(page, 'root-alpha.png').click({ button: 'right' })
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(assets).toHaveAttribute('data-state', 'open')

    await page.keyboard.press('Escape')
    await expect(assets).toHaveAttribute('data-state', 'closed')
  })

  test('unpinned Inspector follows the active selection and auto-hides when it clears', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openFixtureRepo(page, 'dock-fixtures', { drawers: 'closed' })
    const inspector = page.locator('aside[aria-label="Inspector"]')

    await page.getByTestId('toggle-inspector-shelf').click()
    await expect(inspector.getByText('No Selection')).toBeVisible()
    await expect(
      inspector.getByText('Select all on active surface')
    ).toBeVisible()
    await expect(inspector.getByText('Search assets in palette')).toBeVisible()
    await page.getByTestId('toggle-inspector-shelf').click()

    await placeAssets(page, ['dock-alpha.png', 'dock-beta.png'])
    await imageNodes(page).nth(0).click()
    await page.keyboard.press('ControlOrMeta+i')
    await expect(inspector).toHaveAttribute('data-state', 'open')
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.closest('aside')?.getAttribute('aria-label')
        )
      )
      .toBe('Inspector')
    await expect(
      inspector.getByText('dock-alpha.png', { exact: true })
    ).toBeVisible()
    await imageNodes(page).nth(1).click()
    await expect(
      inspector.getByText('dock-beta.png', { exact: true })
    ).toBeVisible()
    await expect(
      inspector.getByText('dock-alpha.png', { exact: true })
    ).toHaveCount(0)
    await page
      .locator('.react-flow__pane')
      .click({ position: { x: 700, y: 460 } })
    await expect(inspector).toHaveAttribute('data-state', 'closed')
    await expect(page.getByRole('main', { name: 'Canvas' })).toBeFocused()

    await page.getByTestId('toggle-inspector-shelf').click()
    await page.getByTestId('pin-shelf-right').click()
    await page
      .locator('.react-flow__pane')
      .click({ position: { x: 700, y: 460 } })
    await expect(inspector).toHaveAttribute('data-state', 'open')
    await expect(inspector.getByText('No Selection')).toBeVisible()
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
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.closest('aside')?.getAttribute('aria-label')
        )
      )
      .toBe('Inspector')
    expect((await canvas.boundingBox())?.width).toBe(390)

    await page.getByTestId('toggle-assets-shelf').click()
    await expect(page.locator('aside[aria-label="Inspector"]')).toHaveAttribute(
      'data-state',
      'closed'
    )
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.closest('aside')?.getAttribute('aria-label')
        )
      )
      .toBe('Assets')
  })
})
