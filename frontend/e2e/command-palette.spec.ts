import { expect, test } from './test-fixtures'
import { asset, openFixtureRepo, placeAssets } from './test-helpers'

test.describe('Canvas command palette', () => {
  test('searches labels, aliases, categories, and keeps unavailable actions explained', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'closed' })
    await page.keyboard.press('ControlOrMeta+k')

    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    const search = page.getByRole('combobox', { name: 'Search commands' })
    await expect(dialog).toBeVisible()
    await search.fill('> zoom extents')
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

    await page.keyboard.press('ControlOrMeta+k')
    await page
      .getByRole('combobox', { name: 'Search commands' })
      .fill('@nested/deeper')
    await expect(
      page.getByRole('option', { name: /folder-delta\.png/ })
    ).toBeVisible()
  })

  test('keeps keyboard navigation visible and runs the active command', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'closed' })
    await page.keyboard.press('ControlOrMeta+k')

    const search = page.getByRole('combobox', { name: 'Search commands' })
    const activeOption = page.locator('[role="option"][aria-selected="true"]')
    await expect(search).toBeFocused()

    const options = await page.getByRole('option').allTextContents()
    const targetIndex = options.findIndex((option) =>
      option.includes('Toggle Focus Canvas')
    )
    expect(targetIndex).toBeGreaterThan(8)
    for (let index = 0; index < targetIndex; index += 1) {
      await page.keyboard.press('ArrowDown')
    }

    await expect(activeOption).toContainText('Toggle Focus Canvas')
    await expect
      .poll(() =>
        activeOption.evaluate((option) => {
          const list = option.closest('[role="listbox"]')
          if (!list) return false
          const optionBounds = option.getBoundingClientRect()
          const listBounds = list.getBoundingClientRect()
          return (
            optionBounds.top >= listBounds.top &&
            optionBounds.bottom <= listBounds.bottom
          )
        })
      )
      .toBe(true)

    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-palette')).toHaveCount(0)
    await expect(page.getByTestId('canvas-workspace-controls')).toHaveAttribute(
      'aria-hidden',
      'true'
    )

    await page.keyboard.press('Control+\\')
    await page.keyboard.press('ControlOrMeta+k')
    const list = page.getByRole('listbox', { name: 'Commands' })
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await search.fill('a')
    const firstResult = page.locator('[role="option"][aria-selected="true"]')
    await expect
      .poll(() =>
        firstResult.evaluate((option) => {
          const container = option.closest('[role="listbox"]')
          if (!container) return false
          const optionBounds = option.getBoundingClientRect()
          const listBounds = container.getBoundingClientRect()
          return (
            optionBounds.top >= listBounds.top &&
            optionBounds.bottom <= listBounds.bottom
          )
        })
      )
      .toBe(true)
  })

  test('asset search matches repository tags', async ({ page }) => {
    await openFixtureRepo(page, 'inspector-fixtures')
    await asset(page, 'inspect-alpha.png').click()
    const inspector = page.getByLabel('Inspector')
    await inspector.getByLabel('Add tag').fill('palette-search-tag')
    await inspector.getByRole('button', { name: 'Add', exact: true }).click()

    await page.keyboard.press('ControlOrMeta+k')
    const search = page.getByRole('combobox', { name: 'Search commands' })
    await search.fill('@palette-search-tag')
    await expect(
      page.getByRole('option', { name: /inspect-alpha\.png/ })
    ).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(
      page
        .locator('aside[aria-label="Assets"]')
        .getByRole('option', { name: 'inspect-alpha.png', exact: true })
    ).toHaveAttribute('aria-selected', 'true')
  })

  test('does not carry restore eligibility across an asset selection change', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'inspector-fixtures')
    const inspector = page.getByLabel('Inspector')
    await asset(page, 'inspect-alpha.png').click()
    await page.keyboard.press('Delete')
    await expect(asset(page, 'inspect-alpha.png')).toHaveCount(0)

    await page.getByRole('button', { name: /^Filters/ }).click()
    await page
      .getByRole('combobox', { name: 'Asset state' })
      .selectOption('trashed')
    await asset(page, 'inspect-alpha.png').click()
    await expect(inspector.getByText('Trashed')).toBeVisible()

    await page
      .getByRole('combobox', { name: 'Asset state' })
      .selectOption('active')
    let resolveGetImageStarted: () => void = () => {}
    const getImageStarted = new Promise<void>((resolve) => {
      resolveGetImageStarted = resolve
    })
    await page.route('**/wails/runtime', async (route) => {
      if (route.request().postData()?.includes('1073816885')) {
        resolveGetImageStarted()
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
      await route.continue()
    })

    await asset(page, 'inspect-beta.png').click()
    await getImageStarted
    await page.keyboard.press('ControlOrMeta+k')
    const search = page.getByRole('combobox', { name: 'Search commands' })
    await search.fill('> Restore from trash')
    const restore = page.getByRole('option', { name: /Restore from trash/ })
    await expect(restore).toHaveAttribute('aria-disabled', 'true')
  })

  test('asset search selects placed results on the Canvas', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-fixtures', { drawers: 'closed' })
    await placeAssets(page, ['dock-alpha.png'])
    await page.keyboard.press('ControlOrMeta+k')
    await page
      .getByRole('combobox', { name: 'Search commands' })
      .fill('@dock-alpha')
    await expect(
      page.getByRole('option', { name: /dock-alpha\.png/ })
    ).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('.react-flow__node.selected')).toContainText(
      'dock-alpha.png'
    )
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
