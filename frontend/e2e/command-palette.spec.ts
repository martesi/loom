import { expect, test } from './test-fixtures'
import {
  asset,
  autoArrangeCanvas,
  openFixtureRepo,
  placeAssets,
  selectImageNodes,
} from './test-helpers'

test.describe('Canvas command palette', () => {
  test('searches labels, aliases, categories, and keeps unavailable actions explained', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'closed' })
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

  test('field commands focus Inspector editors and only explicit submit changes data', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'inspector-fixtures')
    await asset(page, 'inspect-alpha.png').click()
    const inspector = page.getByLabel('Inspector')

    const runPaletteCommand = async (label: string) => {
      await page.getByTestId('open-command-palette').click()
      const search = page.getByRole('combobox', { name: 'Search commands' })
      await search.fill(label)
      await page.getByRole('option', { name: new RegExp(label) }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
    }

    const path = inspector.getByRole('textbox', { name: 'File path' })
    await path.fill('palette-renamed.png')
    await runPaletteCommand('Move or rename file path')
    await expect(path).toBeFocused()
    await expect(asset(page, 'inspect-alpha.png')).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(asset(page, 'palette-renamed.png')).toHaveCount(1)

    const tag = inspector.getByRole('textbox', { name: 'Add tag' })
    await tag.fill('palette-added-tag')
    await runPaletteCommand('Add tag')
    await expect(tag).toBeFocused()
    await expect(tag).toHaveValue('palette-added-tag')
    await expect(
      inspector.getByText('palette-added-tag', { exact: true })
    ).toHaveCount(0)
    await page.keyboard.press('Enter')
    await expect(tag).toHaveValue('')
    await expect(inspector.getByText(/palette-added-tag/)).toBeVisible()

    const prompt = inspector.getByRole('textbox', { name: 'Prompt' })
    const rawPrompt = '  prompt spacing is preserved  '
    await prompt.fill(rawPrompt)
    await runPaletteCommand('Save prompt')
    await expect(prompt).toBeFocused()
    await expect(prompt).toHaveValue(rawPrompt)
    await inspector.getByRole('button', { name: 'Save prompt' }).click()
    await asset(page, 'inspect-beta.png').click()
    await expect(prompt).toHaveValue('')
    await asset(page, 'palette-renamed.png').click()
    await expect(prompt).toHaveValue(rawPrompt)

    await prompt.fill('')
    await inspector.getByRole('button', { name: 'Save prompt' }).click()
    await asset(page, 'inspect-beta.png').click()
    await asset(page, 'palette-renamed.png').click()
    await expect(prompt).toHaveValue('')
    await asset(page, 'inspect-beta.png').click()
    await expect(
      inspector.getByText('inspect-beta.png', { exact: true })
    ).toBeVisible()
    await expect(prompt).not.toBeFocused()
  })

  test('focuses a requested field when a palette command opens a closed Inspector', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'inspector-fixtures')
    await asset(page, 'inspect-alpha.png').click()

    const inspector = page.locator('aside[aria-label="Inspector"]')
    const path = inspector.getByRole('textbox', { name: 'File path' })
    await expect(path).toHaveValue('inspect-alpha.png')
    await inspector.getByTestId('collapse-shelf-right').click()
    await expect(inspector).toHaveAttribute('data-state', 'closed')

    await page.getByTestId('open-command-palette').click()
    const search = page.getByRole('combobox', { name: 'Search commands' })
    await search.fill('Move or rename file path')
    await page.getByRole('option', { name: /Move or rename file path/ }).click()

    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(inspector).toHaveAttribute('data-state', 'open')
    await expect(path).toBeFocused()
    await expect(inspector.getByRole('button').first()).not.toBeFocused()

    await inspector.getByTestId('collapse-shelf-right').click()
    await expect(inspector).toHaveAttribute('data-state', 'closed')
    await page.getByTestId('toggle-inspector-shelf').click()
    await expect(inspector).toHaveAttribute('data-state', 'open')
    await expect(inspector.getByRole('button').first()).toBeFocused()
  })

  test('cancels pending palette field focus when the Inspector closes before image load', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'inspector-fixtures')
    await asset(page, 'inspect-alpha.png').click()
    await asset(page, 'inspect-beta.png').click({ modifiers: ['Shift'] })
    await page.keyboard.press('Delete')
    const trashDialog = page.getByRole('dialog', {
      name: 'Move 2 assets to trash?',
    })
    await expect(trashDialog).toBeVisible()
    await trashDialog.getByRole('button', { name: 'Move to trash' }).click()
    await page.getByRole('button', { name: /^Filters/ }).click()
    await page
      .getByRole('combobox', { name: 'Asset state' })
      .selectOption('trashed')
    await expect(asset(page, 'inspect-alpha.png')).toBeVisible()

    const inspector = page.locator('aside[aria-label="Inspector"]')
    await inspector.getByTestId('collapse-shelf-right').click()
    let releaseImageLoad: () => void = () => {}
    const imageLoadGate = new Promise<void>((resolve) => {
      releaseImageLoad = resolve
    })
    let resolveImageLoadStarted: () => void = () => {}
    const imageLoadStarted = new Promise<void>((resolve) => {
      resolveImageLoadStarted = resolve
    })
    let failImageLoads = false
    let releaseImageFailure: () => void = () => {}
    const imageFailureGate = new Promise<void>((resolve) => {
      releaseImageFailure = resolve
    })
    let resolveImageFailureStarted: () => void = () => {}
    const imageFailureStarted = new Promise<void>((resolve) => {
      resolveImageFailureStarted = resolve
    })
    await page.route('**/wails/runtime', async (route) => {
      if (route.request().postData()?.includes('1073816885')) {
        if (failImageLoads) {
          resolveImageFailureStarted()
          await imageFailureGate
          await route.abort('failed')
          return
        }
        resolveImageLoadStarted()
        await imageLoadGate
      }
      await route.continue()
    })

    await asset(page, 'inspect-alpha.png').click()
    await imageLoadStarted
    await page.getByTestId('open-command-palette').click()
    await page
      .getByRole('combobox', { name: 'Search commands' })
      .fill('Add tag')
    await page.getByRole('option', { name: /Add tag/ }).click()

    const addTag = inspector.getByRole('textbox', { name: 'Add tag' })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(inspector).toHaveAttribute('data-state', 'open')
    await expect(addTag).toHaveCount(0)

    await inspector.getByTestId('collapse-shelf-right').click()
    await expect(inspector).toHaveAttribute('data-state', 'closed')
    await page.getByTestId('toggle-inspector-shelf').click()
    await expect(inspector).toHaveAttribute('data-state', 'open')
    await expect(inspector.getByTestId('pin-shelf-right')).toBeFocused()

    releaseImageLoad()
    await expect(addTag).toHaveCount(1)
    await expect(inspector.getByTestId('pin-shelf-right')).toBeFocused()
    await expect(addTag).not.toBeFocused()

    await page.getByTestId('open-command-palette').click()
    await page
      .getByRole('combobox', { name: 'Search commands' })
      .fill('Add tag')
    await page.getByRole('option', { name: /Add tag/ }).click()
    await expect(addTag).toBeFocused()

    failImageLoads = true
    await inspector.getByTestId('collapse-shelf-right').click()
    await asset(page, 'inspect-beta.png').click()
    await imageFailureStarted
    await page.getByTestId('open-command-palette').click()
    await page
      .getByRole('combobox', { name: 'Search commands' })
      .fill('Add tag')
    await page.getByRole('option', { name: /Add tag/ }).click()
    await expect(addTag).toHaveCount(0)

    releaseImageFailure()
    await expect(
      page.getByRole('alert').filter({ hasText: 'Failed to fetch' })
    ).toBeVisible()
    await inspector.getByTestId('collapse-shelf-right').click()
    await page.getByTestId('toggle-inspector-shelf').click()
    await expect(inspector.getByTestId('pin-shelf-right')).toBeFocused()
  })

  test('restores normal Inspector focus after a field command on a selected set', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'group-fixtures')
    await placeAssets(page, ['group-alpha.png', 'group-beta.png'])
    await autoArrangeCanvas(page)
    await page.keyboard.press('ControlOrMeta+0')
    await selectImageNodes(page, [0, 1])
    await page.getByTestId('dock-create-set').click()

    const inspector = page.locator('aside[aria-label="Inspector"]')
    const group = page.locator('.react-flow__node-group')
    await group.click()
    await expect(group).toHaveClass(/selected/)
    await expect(inspector.getByLabel('Set name')).toBeVisible()

    const paletteTrigger = page.getByTestId('open-command-palette')
    await paletteTrigger.click()
    const search = page.getByRole('combobox', { name: 'Search commands' })
    await search.fill('Add tag')
    await page.getByRole('option', { name: /Add tag/ }).click()

    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(paletteTrigger).toBeFocused()
    await inspector.getByTestId('collapse-shelf-right').click()
    await expect(inspector).toHaveAttribute('data-state', 'closed')
    await page.getByTestId('toggle-inspector-shelf').click()
    await expect(inspector).toHaveAttribute('data-state', 'open')
    await expect(inspector.getByTestId('pin-shelf-right')).toBeFocused()
  })

  test('does not carry restore eligibility across an asset selection change', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'inspector-fixtures')
    const inspector = page.getByLabel('Inspector')
    await asset(page, 'inspect-alpha.png').click()
    await page.keyboard.press('Delete')
    const trashDialog = page.getByRole('dialog', {
      name: 'Move 1 asset to trash?',
    })
    await expect(trashDialog).toBeVisible()
    await trashDialog.getByRole('button', { name: 'Move to trash' }).click()
    await expect(asset(page, 'inspect-alpha.png')).toHaveCount(0)

    await page.getByRole('button', { name: /^Filters/ }).click()
    await page
      .getByRole('combobox', { name: 'Asset state' })
      .selectOption('trashed')
    await asset(page, 'inspect-alpha.png').click()
    await expect(inspector.getByText('Trashed')).toBeVisible()
    const inspectorRestore = inspector.getByRole('button', {
      name: 'Restore from trash',
    })
    await expect(inspectorRestore).toBeVisible()
    await expect(inspectorRestore).toBeEnabled()

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
    if (await inspectorRestore.count())
      await expect(inspectorRestore).toBeDisabled()
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
