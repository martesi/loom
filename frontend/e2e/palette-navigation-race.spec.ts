import { expect, test } from './test-fixtures'
import { imageNodes, openFixtureRepo, placeAssets } from './test-helpers'

test('a delayed palette choice cannot replace a newer canvas selection', async ({
  page,
}, testInfo) => {
  await openFixtureRepo(page, 'dock-fixtures', { drawers: 'closed' })
  await page.getByTestId('canvas-mode-edit').click()
  await placeAssets(page, ['dock-alpha.png', 'dock-beta.png'])
  const alpha = imageNodes(page).filter({ hasText: 'dock-alpha.png' })
  const beta = imageNodes(page).filter({ hasText: 'dock-beta.png' })
  await alpha.click({ position: { x: 20, y: 20 } })
  await page.keyboard.press('ControlOrMeta+k')
  await page
    .getByRole('combobox', { name: 'Search commands' })
    .fill('@dock-alpha')
  const option = page.getByRole('option', { name: /dock-alpha\.png/ })
  await expect(option).toBeVisible()

  const count = await option.evaluate((element) => {
    const state = window as typeof window & {
      heldPaletteFrames: FrameRequestCallback[]
    }
    state.heldPaletteFrames = []
    const original = window.requestAnimationFrame
    window.requestAnimationFrame = (callback) => {
      state.heldPaletteFrames.push(callback)
      return -state.heldPaletteFrames.length
    }
    if (!(element instanceof HTMLElement)) throw new Error('expected a button')
    element.click()
    window.requestAnimationFrame = original
    return state.heldPaletteFrames.length
  })
  expect(count).toBeGreaterThan(0)
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
  await beta.click({ position: { x: 20, y: 20 } })
  await expect(beta).toHaveClass(/selected/)
  await beta.focus()
  await expect(beta).toBeFocused()
  const viewport = await page
    .locator('.react-flow__viewport')
    .getAttribute('style')
  await page.evaluate(async () => {
    const state = window as typeof window & {
      heldPaletteFrames: FrameRequestCallback[]
    }
    for (const callback of state.heldPaletteFrames) callback(performance.now())
    await new Promise((resolve) => setTimeout(resolve, 300))
  })
  await expect(beta).toHaveClass(/selected/)
  await expect(beta).toBeFocused()
  await expect(alpha).not.toHaveClass(/selected/)
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute(
    'style',
    viewport ?? ''
  )
  await testInfo.attach('palette-selection', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
})
