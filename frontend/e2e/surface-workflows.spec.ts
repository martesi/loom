import { expect, test } from './test-fixtures'
import { asset, openFixtureRepo, placeAssets } from './test-helpers'

test.describe('selection ownership across Canvas surfaces', () => {
  test('routes a placed asset through Assets, Inspector, Dock, and palette', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-fixtures', { drawers: 'closed' })
    await page.getByTestId('canvas-mode-edit').click()
    await placeAssets(page, ['dock-alpha.png'])
    const node = page.locator('.react-flow__node-image')
    const assets = page.locator('aside[aria-label="Assets"]')
    const inspector = page.locator('aside[aria-label="Inspector"]')
    const dock = page.getByTestId('canvas-dock')

    await node.click()
    await expect(node).toHaveClass(/selected/)
    await expect(dock).toHaveAttribute('data-mode', 'single')
    await page.getByTestId('toggle-inspector-shelf').click()
    await page.getByTestId('pin-shelf-right').click()
    await expect(inspector).toHaveAttribute('data-state', 'open')
    await expect(
      inspector.getByText('dock-alpha.png', { exact: true })
    ).toBeVisible()

    await page.getByTestId('toggle-assets-shelf').click()
    await asset(page, 'dock-beta.png').click()
    await expect(asset(page, 'dock-beta.png')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(node).not.toHaveClass(/selected/)
    await expect(dock).toHaveAttribute('data-mode', 'idle')
    await expect(
      inspector.getByText('dock-beta.png', { exact: true })
    ).toBeVisible()

    await page.getByTestId('open-command-palette').click()
    const search = page.getByRole('combobox', { name: 'Search commands' })
    await search.fill('@dock-alpha')
    await page.getByRole('option', { name: /dock-alpha\.png/ }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(node).toHaveClass(/selected/)
    await expect(asset(page, 'dock-beta.png')).not.toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(
      inspector.getByText('dock-alpha.png', { exact: true })
    ).toBeVisible()
    await expect(dock).toHaveAttribute('data-mode', 'single')

    await page.getByTestId('dock-inspect').click()
    await expect(inspector).toHaveAttribute('data-state', 'open')
    await expect(
      inspector.getByText('dock-alpha.png', { exact: true })
    ).toBeVisible()
    await page.getByTestId('open-command-palette').click()
    await page
      .getByRole('combobox', { name: 'Search commands' })
      .fill('@dock-alpha')
    await page.getByRole('option', { name: /dock-alpha\.png/ }).click()
    await expect(node).toHaveClass(/selected/)
    await expect(
      inspector.getByText('dock-alpha.png', { exact: true })
    ).toBeVisible()
    await expect(assets).toHaveAttribute('data-state', 'open')
  })

  test('palette search reveals an unplaced asset in All Assets, not Canvas', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-fixtures', { drawers: 'closed' })
    const node = page.locator('.react-flow__node-image')
    const assetsDrawer = page.locator('aside[aria-label="Assets"]')
    await page.getByTestId('open-command-palette').click()
    await page
      .getByRole('combobox', { name: 'Search commands' })
      .fill('@dock-beta')
    await page.getByRole('option', { name: /dock-beta\.png/ }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(assetsDrawer).toHaveAttribute('data-state', 'open')
    await expect(
      assetsDrawer.getByRole('button', { name: 'All Assets', exact: true })
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(asset(page, 'dock-beta.png')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(node).toHaveCount(0)
    await expect(page.getByTestId('canvas-dock')).toHaveAttribute(
      'data-mode',
      'idle'
    )
  })
})
