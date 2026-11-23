import { access, readdir, writeFile } from 'node:fs/promises'
import { expect, test } from './test-fixtures'
import {
  dropAsset,
  fixturePath,
  imageNodes,
  openFixtureRepo,
} from './test-helpers'

const fixturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

test.describe('Settings', () => {
  test('opens from the top-island menu, command palette, and Mod+,', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'closed' })
    await page.getByTestId('repository-actions').click()
    await page.getByRole('menuitem', { name: 'Settings…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Appearance' })
    ).toBeVisible()
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
    await expect(page.locator('html')).toHaveAttribute(
      'data-density',
      'compact'
    )
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('loom.preferences.v1'))
      )
      .toBe(
        JSON.stringify({
          theme: 'dark',
          density: 'compact',
          showTitle: true,
          showResolution: true,
          version: 1,
        })
      )

    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('html')).toHaveAttribute(
      'data-density',
      'compact'
    )
    await page.keyboard.press('ControlOrMeta+,')
    await expect(dialog.getByLabel('Theme')).toHaveText('dark')
    await expect(dialog.getByLabel('Density')).toHaveText('compact')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('html')).toHaveAttribute(
      'data-density',
      'compact'
    )
  })

  test('persists canvas metadata visibility', async ({ page }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'closed' })
    await page.keyboard.press('ControlOrMeta+,')
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByLabel('Show titles').uncheck()
    await dialog.getByLabel('Show resolution').uncheck()
    await expect(page.locator('html')).toHaveAttribute(
      'data-show-title',
      'false'
    )
    await expect(page.locator('html')).toHaveAttribute(
      'data-show-resolution',
      'false'
    )
    await page.reload()
    await page.keyboard.press('ControlOrMeta+,')
    await expect(dialog.getByLabel('Show titles')).not.toBeChecked()
    await expect(dialog.getByLabel('Show resolution')).not.toBeChecked()
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
    await expect(
      dialog.getByRole('heading', { name: 'Keyboard' })
    ).toBeVisible()
    await expect(dialog.locator('kbd').first()).toBeVisible()
    expect(await dialog.getByRole('listitem').count()).toBeGreaterThan(0)
    await expect(dialog.getByText(/Canvas gestures:/)).toBeVisible()
  })

  test('Keyboard section rebinds a shortcut including modifiers', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'direct-fixtures', { drawers: 'closed' })
    await page.keyboard.press('ControlOrMeta+,')
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Keyboard', exact: true }).click()
    const row = dialog
      .getByRole('listitem')
      .filter({ hasText: 'Toggle Inspector' })
    // Modifiers held while recording are captured: Alt+Shift+J records
    // identically on every platform (bare Ctrl would add a physical
    // ctrl part on Linux but only mod on macOS).
    await row.getByTestId('shortcut-change').click()
    await page.keyboard.press('Alt+Shift+J')
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('loom.shortcuts.v1'))
      )
      .toBe(JSON.stringify({ 'toggle-inspector': 'alt+shift+j' }))
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // The rebound combo drives the action; the drawer starts closed.
    const drawer = page.locator('aside[aria-label="Inspector"]')
    await expect(drawer).toHaveAttribute('data-state', 'closed')
    await page.keyboard.press('Alt+Shift+J')
    await expect(drawer).toHaveAttribute('data-state', 'open')

    // Reset restores the default and clears the override.
    await page.keyboard.press('ControlOrMeta+,')
    await dialog.getByRole('button', { name: 'Keyboard', exact: true }).click()
    await dialog
      .getByRole('listitem')
      .filter({ hasText: 'Toggle Inspector' })
      .getByTestId('shortcut-reset')
      .click()
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('loom.shortcuts.v1'))
      )
      .toBe(JSON.stringify({}))
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+I')
    await expect(drawer).toHaveAttribute('data-state', 'closed')
  })

  test('Repository settings rescan discovers sources and reports the count', async ({
    page,
  }, testInfo) => {
    await openFixtureRepo(page, 'rescan-fixtures', { drawers: 'closed' })
    const sourcePath = await fixturePath(
      'rescan-fixtures',
      'settings-added.png'
    )
    await writeFile(sourcePath, fixturePng)
    await page.keyboard.press('ControlOrMeta+,')
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog
      .getByRole('button', { name: 'Repository', exact: true })
      .click()
    await dialog.getByRole('button', { name: 'Rescan repository' }).click()
    await expect(dialog.getByRole('status')).toContainText(
      /\d+ new or changed assets? found\./
    )
    await dialog.getByRole('button', { name: 'Rescan repository' }).click()
    await expect(dialog.getByRole('status')).toHaveText(
      '0 new or changed assets found.'
    )
    await page.screenshot({
      path: testInfo.outputPath('settings-repository.png'),
    })
    await page.keyboard.press('Escape')
    await page.getByTestId('toggle-assets-shelf').click()
    await expect(
      page.getByRole('option', { name: /settings-added\.png/ })
    ).toBeVisible()
  })

  test('Repository settings confirms invalidation and regenerates rendition files', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'preview-fixtures', { drawers: 'closed' })
    const sourcePath = await fixturePath(
      'preview-fixtures',
      'preview-alpha.png'
    )
    const previewsPath = await fixturePath(
      'preview-fixtures',
      '.loom',
      'thumbs'
    )
    await dropAsset(page, 'preview-alpha.png', { x: 500, y: 300 })
    const node = imageNodes(page).first()
    await expect(node).toBeVisible()
    const bounds = await node.boundingBox()
    if (!bounds) throw new Error('Canvas image node has no bounds')
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2
    )
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -900)
    await page.keyboard.up('Control')
    await expect(node.getByTestId('image-node-preview-loaded')).toBeVisible()
    const cachedFiles = () =>
      readdir(previewsPath)
        .then((files) => files.filter((file) => /\.(webp|avif)$/.test(file)))
        .catch(() => [])
    await expect.poll(cachedFiles).not.toHaveLength(0)
    const previewImage = node.getByTestId('image-node-preview-loaded')
    const beforeSrc = await previewImage.getAttribute('src')
    if (!beforeSrc) throw new Error('Loaded preview has no source URL')
    const beforeGeneration = new URL(beforeSrc, page.url()).searchParams.get(
      'ui'
    )
    await page.getByTestId('toggle-assets-shelf').click()
    await page.keyboard.press('ControlOrMeta+,')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings
      .getByRole('button', { name: 'Repository', exact: true })
      .click()
    await settings.getByRole('button', { name: 'Invalidate cache' }).click()
    const confirmation = page.getByRole('dialog', {
      name: 'Invalidate generated renditions?',
    })
    await expect(confirmation).toContainText('It never deletes source files.')
    await confirmation.getByRole('button', { name: 'Cancel' }).click()
    await expect.poll(cachedFiles).not.toHaveLength(0)

    await page.route('**/loom-asset/**', (route) => route.abort())
    await settings.getByRole('button', { name: 'Invalidate cache' }).click()
    await page
      .getByRole('dialog', { name: 'Invalidate generated renditions?' })
      .getByRole('button', { name: 'Invalidate cache' })
      .click()
    await expect(settings.getByRole('status')).toContainText(
      /\d+ generated renditions? removed\./
    )
    await expect
      .poll(async () => {
        const src = await previewImage.getAttribute('src')
        return src ? new URL(src, page.url()).searchParams.get('ui') : null
      })
      .not.toBe(beforeGeneration)
    const regeneratedUrl = await previewImage.getAttribute('src')
    if (!regeneratedUrl)
      throw new Error('Invalidated preview has no source URL')
    const previewRevision = new URL(
      regeneratedUrl,
      page.url()
    ).searchParams.get('v')
    expect(previewRevision).toBeTruthy()
    await expect.poll(cachedFiles).toHaveLength(0)
    await access(sourcePath)

    await page.unroute('**/loom-asset/**')
    const response = await page.request.get(
      new URL(regeneratedUrl, page.url()).href
    )
    expect(response.ok()).toBe(true)
    await expect.poll(cachedFiles).not.toHaveLength(0)
    await page.keyboard.press('Escape')
    await access(sourcePath)
  })
})
