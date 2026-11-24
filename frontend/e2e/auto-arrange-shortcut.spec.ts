import type { Locator } from '@playwright/test'
import { expect, test } from './test-fixtures'
import {
  imageNodes,
  openFixtureRepo,
  placeAssets,
  selectImageNodes,
} from './test-helpers'

async function positions(nodes: Locator) {
  return nodes.evaluateAll((elements) =>
    elements.map((element) => (element as HTMLElement).style.transform)
  )
}

test('auto-arrange can be rebound, executed, persisted, and reset', async ({
  page,
}, testInfo) => {
  await openFixtureRepo(page, 'dock-arrange-fixtures', { drawers: 'closed' })
  await placeAssets(page, [
    'arrange-alpha.png',
    'arrange-beta.png',
    'arrange-gamma.png',
  ])
  await selectImageNodes(page, [0, 1])
  const nodes = imageNodes(page)
  const before = await positions(nodes)

  await page.keyboard.press('ControlOrMeta+k')
  await page
    .getByRole('combobox', { name: 'Search commands' })
    .fill('Auto-arrange Canvas')
  await expect(
    page.getByRole('option', { name: /Auto-arrange Canvas/ })
  ).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('dialog', { name: 'Command palette' })
  ).toHaveCount(0)
  await page.getByRole('main', { name: 'Canvas' }).focus()

  await page.keyboard.press('ControlOrMeta+,')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: 'Keyboard', exact: true }).click()
  const row = dialog
    .getByRole('listitem')
    .filter({ hasText: 'Auto-arrange Canvas' })
  await expect(row).toHaveCount(1)
  await row.getByTestId('shortcut-change').click()
  await page.keyboard.press('Alt+Shift+J')
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('loom.shortcuts.v1')))
    .toBe(JSON.stringify({ 'auto-arrange-active': 'alt+shift+j' }))
  await testInfo.attach('auto-arrange-settings', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  await page.getByTestId('dock-auto-arrange').hover()
  const tooltip = page.getByTestId('base-tooltip-popup')
  await expect(tooltip).toContainText('Auto-arrange')
  await expect(tooltip.locator('kbd')).toHaveText(['Alt', 'Shift', 'J'])
  await page.getByRole('main', { name: 'Canvas' }).focus()
  await page.keyboard.press('Shift+A')
  await expect(positions(nodes)).resolves.toEqual(before)
  await page.keyboard.press('Alt+Shift+J')
  await expect
    .poll(async () => (await positions(nodes))[2])
    .not.toEqual(before[2])
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => positions(nodes)).toEqual(before)

  await page.reload()
  await expect(nodes).toHaveCount(3)
  await page.getByRole('main', { name: 'Canvas' }).focus()
  await page.keyboard.press('Alt+Shift+J')
  await expect
    .poll(async () => (await positions(nodes))[2])
    .not.toEqual(before[2])
  await page.keyboard.press('ControlOrMeta+,')
  await dialog.getByRole('button', { name: 'Keyboard', exact: true }).click()
  await row.getByTestId('shortcut-reset').click()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('loom.shortcuts.v1')))
    .toBe('{}')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.getByRole('main', { name: 'Canvas' }).focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => positions(nodes)).toEqual(before)
  await page.keyboard.press('Shift+A')
  await expect
    .poll(async () => (await positions(nodes))[2])
    .not.toEqual(before[2])
})

for (const id of ['auto-arrange-active', 'auto-arrange-canvas']) {
  test(`honors and resets persisted ${id} overrides`, async ({ page }) => {
    await openFixtureRepo(page, 'dock-arrange-fixtures', { drawers: 'closed' })
    await placeAssets(page, [
      'arrange-alpha.png',
      'arrange-beta.png',
      'arrange-gamma.png',
    ])
    await page.evaluate((actionId) => {
      localStorage.setItem(
        'loom.shortcuts.v1',
        JSON.stringify({ [actionId]: 'alt+shift+j' })
      )
    }, id)
    await page.reload()
    const nodes = imageNodes(page)
    await expect(nodes).toHaveCount(3)
    const before = await positions(nodes)
    await page.getByRole('main', { name: 'Canvas' }).focus()
    await page.keyboard.press('Alt+Shift+J')
    await expect
      .poll(async () => (await positions(nodes))[2])
      .not.toEqual(before[2])
    await page.keyboard.press('ControlOrMeta+,')
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Keyboard', exact: true }).click()
    await dialog
      .getByRole('listitem')
      .filter({ hasText: 'Auto-arrange Canvas' })
      .getByTestId('shortcut-reset')
      .click()
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('loom.shortcuts.v1'))
      )
      .toBe('{}')
    await page.reload()
    await page.keyboard.press('ControlOrMeta+,')
    await dialog.getByRole('button', { name: 'Keyboard', exact: true }).click()
    await expect(
      dialog
        .getByRole('listitem')
        .filter({ hasText: 'Auto-arrange Canvas' })
        .getByTestId('shortcut-reset')
    ).toHaveCount(0)
  })
}
