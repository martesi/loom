import { getImageMethodID } from './bindings'
import { expect, test } from './test-fixtures'
import { asset, openFixtureRepo } from './test-helpers'

test.describe('Inspector commands from the Canvas command palette', () => {
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
      if (route.request().postData()?.includes(getImageMethodID)) {
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
      if (route.request().postData()?.includes(getImageMethodID)) {
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
    await expect(restore).toHaveCount(0)
  })
})
