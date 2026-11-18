import { expect, test } from '@playwright/test'
import { openFixtureRepo } from './test-helpers'

test.describe('Canvas command palette', () => {
  test('searches labels, aliases, categories, and keeps unavailable actions explained', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'closed' })
    await page.keyboard.press('ControlOrMeta+k')

    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    const search = page.getByRole('combobox', { name: 'Search commands' })
    await expect(dialog).toBeVisible()
    await search.fill('zoom extents')
    await expect(page.getByRole('option', { name: /Fit all/ })).toBeVisible()
    await expect(page.locator('[role=status]')).toContainText('results')

    await search.fill('Canvas view')
    await expect(
      page.getByRole('option', { name: /Fit selection/ })
    ).toBeVisible()
    await search.fill('Fit selection')
    await expect(
      page.getByRole('option', { name: /Select a Canvas item/ })
    ).toHaveAttribute('aria-disabled', 'true')
  })

  test('executes navigation actions and searches repository assets with @', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'library-fixtures', { drawers: 'closed' })
    await page.keyboard.press('ControlOrMeta+k')
    const search = page.getByRole('combobox', { name: 'Search commands' })
    await search.fill('Show Folders')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('aside[aria-label="Assets"]')).toHaveAttribute(
      'data-state',
      'open'
    )
    await expect(
      page.getByRole('button', { name: 'Folders', exact: true })
    ).toHaveAttribute('aria-pressed', 'true')

    await page.keyboard.press('ControlOrMeta+k')
    const reopenedSearch = page.getByRole('combobox', {
      name: 'Search commands',
    })
    await expect(reopenedSearch).toBeFocused()
    await reopenedSearch.fill('@folder-gamma')
    await expect(
      page.getByRole('option', { name: /folder-gamma\.png/ })
    ).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(
      page.locator('[role=option][aria-selected=true]')
    ).toContainText('folder-gamma.png')
  })

  test('restores focus, lists shortcuts, and leaves browser shortcuts alone in the search field', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'closed' })
    const trigger = page.getByTestId('open-command-palette')
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    const search = page.getByRole('combobox', { name: 'Search commands' })
    await expect(search).toBeFocused()
    await page.keyboard.press('Control+b')
    await expect(dialog).toBeVisible()
    await expect(page.locator('aside[aria-label="Assets"]')).toHaveAttribute(
      'data-state',
      'closed'
    )
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()

    await page.keyboard.press('?')
    await expect(
      page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    ).toBeVisible()
    await expect(
      page.getByRole('combobox', { name: 'Search keyboard shortcuts' })
    ).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('Focus Canvas hides chrome, keeps the palette available, and exits with its shortcut', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'closed' })
    const controls = page.getByTestId('canvas-workspace-controls')
    await page.keyboard.press('Control+\\')
    await expect(controls).toHaveAttribute('aria-hidden', 'true')
    await expect(controls).toHaveAttribute('inert', '')
    await expect(page.getByTestId('canvas-dock')).toHaveCount(0)
    await expect(page.getByTestId('shelf-edge-trigger-left')).toHaveCount(0)
    await expect(page.locator('aside[aria-label="Assets"]')).toHaveAttribute(
      'data-visible',
      'false'
    )

    await page.keyboard.press('ControlOrMeta+k')
    await expect(
      page.getByRole('dialog', { name: 'Command palette' })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('command-palette')).toHaveCount(0)
    await expect(page.getByRole('main', { name: 'Canvas' })).toBeFocused()
    await page.keyboard.press('Control+\\')
    await expect(controls).toHaveAttribute('aria-hidden', 'false')
    await expect(page.getByTestId('canvas-dock')).toBeVisible()
  })
})
