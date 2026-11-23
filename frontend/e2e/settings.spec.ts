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
    const cachedFiles = () =>
      readdir(previewsPath)
        .then((files) => files.filter((file) => /\.(webp|avif)$/.test(file)))
        .catch(() => [])
    await expect.poll(cachedFiles).not.toHaveLength(0)
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
    await page.keyboard.press('Escape')

    const bounds = await node.boundingBox()
    if (!bounds) throw new Error('Canvas image node has no bounds')
    let releaseStaleRequest: (() => void) | undefined
    let releaseCurrentRequest: (() => void) | undefined
    const staleRequestGate = new Promise<void>((resolve) => {
      releaseStaleRequest = resolve
    })
    const currentRequestGate = new Promise<void>((resolve) => {
      releaseCurrentRequest = resolve
    })
    let staleRequestStarted = () => {}
    let currentRequestStarted = () => {}
    const staleRequestPending = new Promise<void>((resolve) => {
      staleRequestStarted = resolve
    })
    const currentRequestPending = new Promise<void>((resolve) => {
      currentRequestStarted = resolve
    })
    let previewRequestCount = 0
    let stalePreviewUrl = ''
    let currentPreviewUrl = ''
    await page.route('**/loom-asset/thumb/**', (route) => route.abort())
    await page.route('**/loom-asset/preview/**', async (route) => {
      previewRequestCount += 1
      if (previewRequestCount === 1) {
        stalePreviewUrl = route.request().url()
        staleRequestStarted()
        await staleRequestGate
      } else if (previewRequestCount === 2) {
        currentPreviewUrl = route.request().url()
        currentRequestStarted()
        await currentRequestGate
      }
      await route.continue()
    })
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2
    )
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -1600)
    await page.keyboard.up('Control')
    await staleRequestPending
    await expect(node.getByTestId('image-node-preview')).toBeVisible()
    const stalePendingSrc = await node
      .getByTestId('image-node-preview')
      .getAttribute('src')
    if (!stalePendingSrc) throw new Error('Pending preview has no source URL')
    expect(
      new URL(stalePendingSrc, page.url()).searchParams.get('ui')
    ).toBeNull()

    await page.keyboard.press('ControlOrMeta+,')
    await settings
      .getByRole('button', { name: 'Repository', exact: true })
      .click()
    await settings.getByRole('button', { name: 'Invalidate cache' }).click()
    await page
      .getByRole('dialog', { name: 'Invalidate generated renditions?' })
      .getByRole('button', { name: 'Invalidate cache' })
      .click()
    await expect(settings.getByRole('status')).toContainText(
      /\d+ generated renditions? removed\./
    )
    await currentRequestPending
    expect(new URL(currentPreviewUrl).searchParams.get('ui')).not.toBe(null)
    expect(new URL(stalePreviewUrl).searchParams.get('ui')).toBeNull()
    const currentPending = node.getByTestId('image-node-preview')
    await expect
      .poll(async () => {
        const src = await currentPending.getAttribute('src')
        return src ? new URL(src, page.url()).href : null
      })
      .toBe(currentPreviewUrl)
    await expect.poll(cachedFiles).toHaveLength(0)
    await access(sourcePath)

    if (!releaseStaleRequest || !releaseCurrentRequest)
      throw new Error('Preview request gates were not initialized')
    const staleResponse = page.waitForResponse(
      (response) => response.url() === stalePreviewUrl
    )
    releaseStaleRequest()
    await staleResponse
    await expect(node.getByTestId('image-node-preview')).toBeVisible()
    await expect(node.getByTestId('image-node-preview-loaded')).toHaveCount(0)

    const currentResponse = page.waitForResponse(
      (response) => response.url() === currentPreviewUrl
    )
    releaseCurrentRequest()
    await currentResponse
    await expect(node.getByTestId('image-node-preview-loaded')).toBeVisible()
    const recoveredSrc = await node
      .getByTestId('image-node-preview-loaded')
      .getAttribute('src')
    if (!recoveredSrc) throw new Error('Recovered preview has no source URL')
    const recoveredUrl = new URL(recoveredSrc, page.url())
    expect(recoveredUrl.searchParams.get('ui')).toBe(
      new URL(currentPreviewUrl).searchParams.get('ui')
    )
    expect(recoveredUrl.searchParams.get('v')).toBe(
      new URL(currentPreviewUrl).searchParams.get('v')
    )
    await page.unroute('**/loom-asset/**')
    await expect.poll(cachedFiles).not.toHaveLength(0)
    await page.keyboard.press('Escape')
    await access(sourcePath)
  })
})
