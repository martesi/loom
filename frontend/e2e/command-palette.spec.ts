import { expect, test } from './test-fixtures'
import { asset, openFixtureRepo, placeAssets } from './test-helpers'

test.describe('Canvas command palette', () => {
  test('searches labels, aliases, and categories while hiding unavailable actions', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'closed' })
    await placeAssets(page, ['direct-alpha.png'])
    await page.keyboard.press('ControlOrMeta+k')

    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    const search = page.getByRole('combobox', { name: 'Search commands' })
    await expect(dialog).toBeVisible()
    const inputShell = page.getByTestId('command-palette-input-shell')
    await expect(inputShell).toHaveClass(/h-11/)
    await expect(inputShell).toHaveClass(/border-b/)
    await expect(inputShell.locator('svg')).toBeVisible()
    await expect(search).toHaveClass(/text-sm/)
    expect((await search.boundingBox())?.height).toBe(44)
    await search.fill('zoom extents')
    await expect(page.getByRole('option', { name: /Fit all/ })).toBeVisible()
    await expect(page.locator('[role=status]')).toContainText('results')

    await search.fill('Select all')
    await expect(
      dialog.getByText('Selection', { exact: true }).first()
    ).toBeVisible()

    await search.fill('Canvas view')
    await expect(
      page.getByRole('option', { name: /Fit selection/ })
    ).toBeVisible()
    await search.fill('Fit selection')
    await expect(
      page.getByRole('option', { name: /Select a Canvas item/ })
    ).toHaveCount(0)
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

    // A single filtered result hides scrolling bugs. "canvas" matches the whole
    // Canvas view category, so shrink the listbox to the height of one option,
    // prove the second result starts out of view, then ArrowDown to it and poll
    // until it is fully visible.
    await search.fill('canvas')
    const listbox = page.getByRole('listbox', { name: 'Commands' })
    const resultOptions = listbox.getByRole('option')
    await expect(resultOptions.nth(1)).toBeVisible()
    const firstResultBounds = await resultOptions.first().boundingBox()
    if (!firstResultBounds) throw new Error('first result has no bounds')
    await listbox.evaluate((element, height) => {
      element.style.maxHeight = `${height}px`
    }, Math.floor(firstResultBounds.height))
    const listBounds = await listbox.boundingBox()
    const secondResultBounds = await resultOptions.nth(1).boundingBox()
    if (!listBounds || !secondResultBounds)
      throw new Error('listbox or second result has no bounds')
    expect(secondResultBounds.y).toBeGreaterThanOrEqual(
      listBounds.y + listBounds.height - 1
    )

    await page.keyboard.press('ArrowDown')
    await expect(resultOptions.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect
      .poll(() =>
        resultOptions.nth(1).evaluate((option) => {
          const list = option.closest('[role="listbox"]')
          if (!list) return false
          const optionBox = option.getBoundingClientRect()
          const listBox = list.getBoundingClientRect()
          const tolerance = 1
          return (
            optionBox.top >= listBox.top - tolerance &&
            optionBox.bottom <= listBox.bottom + tolerance
          )
        })
      )
      .toBe(true)
    await listbox.evaluate((element) => {
      element.style.maxHeight = ''
    })

    // Filter before walking so the test does not depend on the full command
    // ordering and does not need dozens of key round-trips.
    await search.fill('focus canvas')
    await expect(
      page.getByRole('option', { name: /Toggle Focus Canvas/ })
    ).toBeVisible()
    const options = await page.getByRole('option').allTextContents()
    const targetIndex = options.findIndex((option) =>
      option.includes('Toggle Focus Canvas')
    )
    expect(targetIndex).toBeGreaterThanOrEqual(0)
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

    await expect(search).toBeFocused()
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

  test('Enter runs the focused result after focus leaves the search field', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'closed' })
    await page.getByTestId('toggle-assets-shelf').click()
    const folders = page.getByRole('button', { name: 'Folders', exact: true })
    await folders.click()
    await expect(folders).toHaveAttribute('aria-pressed', 'true')

    await page.keyboard.press('ControlOrMeta+k')

    const search = page.getByRole('combobox', { name: 'Search commands' })
    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    const focusedOption = page.locator('[role="option"]:focus')
    const activeOption = page.locator('[role="option"][aria-selected="true"]')
    await expect(search).toBeFocused()
    await search.fill('show')

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(activeOption).toContainText('Show All Assets')

    await page.keyboard.press('Tab')
    await expect(focusedOption).toContainText('Open Assets')
    await expect(focusedOption).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')

    await expect(dialog).toHaveCount(0)
    await expect(folders).toHaveAttribute('aria-pressed', 'true')
  })

  test('arrow navigation keeps focus and selection together on result buttons', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'closed' })
    await page.keyboard.press('ControlOrMeta+k')

    const search = page.getByRole('combobox', { name: 'Search commands' })
    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    const focusedOption = page.locator('[role="option"]:focus')
    const activeOption = page.locator('[role="option"][aria-selected="true"]')
    await search.fill('show')
    await page.keyboard.press('Tab')
    await expect(focusedOption).toContainText('Open Assets')
    await expect(focusedOption).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.press('ArrowDown')
    await expect(activeOption).toContainText('Open Inspector')
    await expect(focusedOption).toContainText('Open Inspector')
    await page.keyboard.press('Enter')

    await expect(dialog).toHaveCount(0)
    await expect(page.locator('aside[aria-label="Assets"]')).toHaveAttribute(
      'data-state',
      'closed'
    )
    await expect(page.locator('aside[aria-label="Inspector"]')).toHaveAttribute(
      'data-state',
      'open'
    )
  })

  test('pointer hover keeps a focused result selected for Enter', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'closed' })
    await page.keyboard.press('ControlOrMeta+k')

    const search = page.getByRole('combobox', { name: 'Search commands' })
    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    const focusedOption = page.locator('[role="option"]:focus')
    const activeOption = page.locator('[role="option"][aria-selected="true"]')
    await search.fill('show')
    await page.keyboard.press('Tab')
    await expect(focusedOption).toContainText('Open Assets')
    await expect(focusedOption).toHaveAttribute('aria-selected', 'true')

    await page.getByRole('option', { name: /Open Inspector/ }).hover()
    await expect(focusedOption).toContainText('Open Assets')
    await expect(activeOption).toContainText('Open Assets')
    await page.keyboard.press('Enter')

    await expect(dialog).toHaveCount(0)
    await expect(page.locator('aside[aria-label="Assets"]')).toHaveAttribute(
      'data-state',
      'open'
    )
    await expect(page.locator('aside[aria-label="Inspector"]')).toHaveAttribute(
      'data-state',
      'closed'
    )
  })

  test('asset search matches repository tags', async ({ page }) => {
    await openFixtureRepo(page, 'inspector-fixtures')
    await asset(page, 'inspect-alpha.png').click()
    const inspector = page.getByLabel('Inspector')
    await inspector.getByLabel('Add tag').fill('palette-search-tag')
    await inspector
      .getByRole('button', { name: 'Add to selected assets', exact: true })
      .click()
    await expect(inspector.getByLabel('Tag summary')).toContainText(
      'palette-search-tag'
    )

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
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
    await page.getByRole('button', { name: 'Keyboard', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Keyboard', exact: true })
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
    await expect(page.getByTestId('toggle-assets-shelf')).toHaveCount(1)
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
