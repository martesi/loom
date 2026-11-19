import { expect, test } from './test-fixtures'
import { openFixtureRepo } from './test-helpers'

test.describe('Settings', () => {
  test('opens from the top-island menu, command palette, and Mod+,', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'closed' })
    await page.getByTestId('repository-actions').click()
    await page.getByRole('menuitem', { name: 'Settings…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    await page.getByTestId('open-command-palette').click()
    const search = page.getByRole('combobox', { name: 'Search commands' })
    await search.fill('Open Settings')
    await page.getByRole('option', { name: /Open Settings/ }).click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    await page.keyboard.press('ControlOrMeta+,')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('persists appearance and density preferences after reload', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'closed' })
    await page.keyboard.press('ControlOrMeta+,')
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByLabel('Theme').click()
    await page.getByRole('option', { name: 'Dark' }).press('Enter')
    await dialog.getByLabel('Density').click()
    await page.getByRole('option', { name: 'Compact' }).press('Enter')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact')
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('loom.preferences.v1')))
      .toBe(JSON.stringify({ theme: 'dark', density: 'compact', version: 1 }))

    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact')
    await page.keyboard.press('ControlOrMeta+,')
    await expect(dialog.getByLabel('Theme')).toHaveText('dark')
    await expect(dialog.getByLabel('Density')).toHaveText('compact')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact')
  })

  test('uses safe defaults and warns when stored preferences are corrupt', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'closed' })
    await page.evaluate(() =>
      localStorage.setItem('loom.preferences.v1', '{not valid json')
    )
    await page.reload()
    await page.keyboard.press('ControlOrMeta+,')
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog.getByLabel('Theme')).toHaveText('system')
    await expect(dialog.getByLabel('Density')).toHaveText('comfortable')
  })

  test('Escape closes Settings before an open drawer', async ({ page }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'assets' })
    const drawer = page.locator('aside[aria-label="Assets"]')
    await expect(drawer).toHaveAttribute('data-state', 'open')
    await page.keyboard.press('ControlOrMeta+,')
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(drawer).toHaveAttribute('data-state', 'open')
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveAttribute('data-state', 'closed')
  })

  test('Keyboard section lists shortcuts from the workspace', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'closed' })
    await page.keyboard.press('ControlOrMeta+,')
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Keyboard', exact: true }).click()
    await expect(dialog.getByRole('heading', { name: 'Keyboard' })).toBeVisible()
    await expect(dialog.locator('kbd').first()).toBeVisible()
    expect(await dialog.getByRole('listitem').count()).toBeGreaterThan(0)
    await expect(dialog.getByText(/Canvas gestures:/)).toBeVisible()
  })
})
