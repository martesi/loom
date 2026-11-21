import { expect, test } from './test-fixtures'
import {
  autoArrangeCanvas,
  ctrlDrag,
  imageNodes,
  openFixtureRepo,
  placeAssets,
} from './test-helpers'

// Covers the lightbox rework: close top-left, actions top-right, history
// back/forward + prev/next in the top bar, and the info panel closed by
// default behind the Info toggle.
test('lightbox chrome layout, info toggle, and history navigation', async ({
  page,
}) => {
  await openFixtureRepo(page, 'lightbox-fixtures', { drawers: 'closed' })
  await placeAssets(page, ['lightbox-alpha.png', 'lightbox-beta.png'])
  await autoArrangeCanvas(page)
  await page.keyboard.press('ControlOrMeta+0')

  // Let the arrange + reset-zoom re-render settle before measuring drag
  // points (same preamble as board-behaviors: click + hint assertion).
  const nodes = imageNodes(page)
  await nodes.nth(0).click()
  await expect(page.getByText(/Ctrl\/Cmd-drag this image/)).toBeVisible()

  // Alpha -> beta relationship so the info panel has a "Derived from" jump.
  await ctrlDrag(page, nodes.nth(0), nodes.nth(1))
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)

  // Double-click the derived image to open the preview viewer.
  await nodes.nth(1).dblclick()

  const close = page.getByTestId('lightbox-close')
  const toolbar = page.getByTestId('lightbox-toolbar')
  await expect(close).toBeVisible()
  await expect(toolbar).toBeVisible()

  // Close sits top-left, actions cluster top-right.
  const viewportWidth = (await page.viewportSize())?.width ?? 1280
  const closeBox = await close.boundingBox()
  const toolbarBox = await toolbar.boundingBox()
  if (!closeBox || !toolbarBox) throw new Error('lightbox chrome has no box')
  expect(closeBox.x + closeBox.width).toBeLessThan(viewportWidth / 2)
  expect(toolbarBox.x).toBeGreaterThan(viewportWidth / 2)

  // Info panel starts closed; the toggle opens and closes it.
  const panel = page.getByTestId('lightbox-info-panel')
  const infoToggle = page.getByTestId('lightbox-info-toggle')
  await expect(panel).toHaveCount(0)
  await expect(infoToggle).toHaveAttribute('aria-pressed', 'false')
  await infoToggle.click()
  await expect(panel).toBeVisible()
  await expect(infoToggle).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.getByText('lightbox-beta.png')).toBeVisible()
  await expect(panel.getByText('Derived from')).toBeVisible()

  // Top-bar actions are all present.
  for (const testId of [
    'lightbox-history-back',
    'lightbox-history-forward',
    'lightbox-prev',
    'lightbox-next',
    'lightbox-zoom-in',
    'lightbox-zoom-out',
    'lightbox-copy',
    'lightbox-download',
  ]) {
    await expect(page.getByTestId(testId)).toBeVisible()
  }

  // No history yet: back/forward stay disabled.
  await expect(page.getByTestId('lightbox-history-back')).toBeDisabled()
  await expect(page.getByTestId('lightbox-history-forward')).toBeDisabled()

  // Jump to the source image through "Derived from".
  await panel.getByRole('button', { name: 'lightbox-alpha.png' }).click()
  await expect(panel.getByText('lightbox-alpha.png')).toBeVisible()
  await expect(page.getByTestId('lightbox-history-back')).toBeEnabled()

  // Back returns to beta, enabling forward; forward goes to alpha again.
  await page.getByTestId('lightbox-history-back').click()
  await expect(panel.getByText('lightbox-beta.png')).toBeVisible()
  await expect(page.getByTestId('lightbox-history-forward')).toBeEnabled()
  await page.getByTestId('lightbox-history-forward').click()
  await expect(panel.getByText('lightbox-alpha.png')).toBeVisible()

  // Linear prev/next moves through the carousel.
  await page.getByTestId('lightbox-prev').click()
  await expect(panel.getByText('lightbox-beta.png')).toBeVisible()
  await page.getByTestId('lightbox-next').click()
  await expect(panel.getByText('lightbox-alpha.png')).toBeVisible()

  // Zoom controls activate without errors.
  await page.getByTestId('lightbox-zoom-in').click()
  await page.getByTestId('lightbox-zoom-out').click()

  // Download points at the current image.
  const download = page.getByTestId('lightbox-download')
  await expect(download).toHaveAttribute('href', /.+/)
  await expect(download).toHaveAttribute('download', 'lightbox-alpha.png')

  // 'i' hides the panel, 'i' again restores it, toggle still works after.
  await page.keyboard.press('i')
  await expect(panel).toHaveCount(0)
  await page.keyboard.press('i')
  await expect(panel).toBeVisible()

  // Close dismisses the viewer.
  await close.click()
  await expect(toolbar).toHaveCount(0)
  await expect(imageNodes(page)).toHaveCount(2)
})
