import { expect, test } from './test-fixtures'
import {
  autoArrangeCanvas,
  ctrlDrag,
  enterEdit,
  imageNodes,
  openFixtureRepo,
} from './test-helpers'

// Covers the lightbox rework: close top-left, actions top-right, history
// back/forward + prev/next in the top bar, and the info panel closed by
// default behind the Info toggle.
test('lightbox chrome layout, info toggle, and history navigation', async ({
  page,
}) => {
  await openFixtureRepo(page, 'lightbox-fixtures', { drawers: 'closed' })
  await enterEdit(page)
  await expect(imageNodes(page)).toHaveCount(6)
  await autoArrangeCanvas(page)
  await page.keyboard.press('ControlOrMeta+0')

  // Let the arrange + reset-zoom re-render settle before measuring drag
  // points (same preamble as board-behaviors: click + hint assertion).
  const nodes = imageNodes(page)
  const alpha = nodes.filter({ hasText: 'lightbox-alpha.png' })
  const beta = nodes.filter({ hasText: 'lightbox-beta.png' })
  await alpha.click()
  await page.getByTestId('toggle-inspector-shelf').click()
  await expect(page.getByText(/Ctrl\/Cmd-drag this image/)).toBeVisible()

  // Alpha -> beta relationship so the info panel has a "Derived from" jump.
  await ctrlDrag(page, alpha, beta)
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)

  // Double-click the derived image to open the preview viewer.
  await beta.dblclick()

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

  // Prev/next traverse the linked relationship chain, skipping the
  // unrelated gamma image (two linked slides: either direction wraps).
  await page.getByTestId('lightbox-prev').click()
  await expect(panel.getByText('lightbox-beta.png')).toBeVisible()
  await page.getByTestId('lightbox-next').click()
  await expect(panel.getByText('lightbox-alpha.png')).toBeVisible()
  await page.getByTestId('lightbox-next').click()
  await expect(panel.getByText('lightbox-beta.png')).toBeVisible()
  await expect(panel.getByText('lightbox-gamma.png')).toHaveCount(0)
  await page.getByTestId('lightbox-prev').click()
  await expect(panel.getByText('lightbox-alpha.png')).toBeVisible()

  // Zoom controls activate without errors.
  await page.getByTestId('lightbox-zoom-in').click()
  await page.getByTestId('lightbox-zoom-out').click()

  // Scroll gestures zoom the current image. Fixture bitmaps for the other
  // suites are 1x1 px, which locks the Zoom plugin at minZoom === maxZoom;
  // the lightbox fixtures are 1600x1200 precisely so zoom can move. The
  // carousel also renders off-screen neighbor slides, so wheel over the
  // slide-area center (viewport minus the open info panel) and compare
  // against the measured pre-wheel width.
  const slideAreaCenter = () =>
    page.evaluate(() => {
      const panel = document.querySelector(
        '[data-testid="lightbox-info-panel"]'
      )
      const panelWidth = panel ? panel.getBoundingClientRect().width : 0
      return {
        x: (window.innerWidth - panelWidth) / 2,
        y: window.innerHeight / 2,
      }
    })
  const maxSlideWidth = () =>
    page.evaluate(() =>
      Math.max(
        0,
        ...[...document.querySelectorAll('.yarl__slide_image')].map(
          (element) => element.getBoundingClientRect().width
        )
      )
    )
  const beforeZoom = await maxSlideWidth()
  expect(beforeZoom).toBeGreaterThan(0)
  const center = await slideAreaCenter()
  await page.mouse.move(center.x, center.y)
  await page.mouse.wheel(0, -600)
  await expect.poll(maxSlideWidth).toBeGreaterThan(beforeZoom)

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
  await expect(imageNodes(page)).toHaveCount(6)
})
