import type { Page } from '@playwright/test'
import { expect, test } from './test-fixtures'
import {
  asset,
  openAssetsShelf,
  openFixtureRepo,
} from './test-helpers'

// Folder-opened preview carousel: opening the preview from the folder view
// traverses the images of that folder in folder order, and images from
// other folders never appear. Canvas-opened preview keeps the relationship
// traversal contract (covered by lightbox.spec.ts, run alongside this file).
//
// Entry point (src contract): AssetList rows double-click to preview in
// Folders mode only (asset-list.tsx onDoubleClick → library-panel onPreview
// → canvas handleFolderPreview, origin { surface: 'folder' }). Single click
// stays selection.
async function openPreviewFromFolderRow(page: Page, fileName: string) {
  await asset(page, fileName).dblclick()
}

test('folder-opened preview traverses folder images in folder order', async ({
  page,
}) => {
  await openFixtureRepo(page, 'lightbox-fixtures', { drawers: 'closed' })
  await openAssetsShelf(page)

  // Folders mode, then into the album subfolder. (Folders mode has no
  // sort control; display order is recency. Carousel order comes from the
  // ListDirectory file order the folder view captures — os.ReadDir filename
  // order — asserted through the traversal below.)
  await page.getByRole('button', { name: 'Folders', exact: true }).click()
  await page.getByRole('button', { name: /album/ }).click()

  // Folder isolation in the list itself: the three album images, no root
  // images leaking in.
  await expect(asset(page, 'lightbox-delta.png')).toBeVisible()
  await expect(asset(page, 'lightbox-epsilon.png')).toBeVisible()
  await expect(asset(page, 'lightbox-zeta.png')).toBeVisible()
  for (const root of [
    'lightbox-alpha.png',
    'lightbox-beta.png',
    'lightbox-gamma.png',
  ]) {
    await expect(asset(page, root)).toHaveCount(0)
  }

  // Folder entry point: double-click the folder row (single click would
  // only select). The carousel opens at the clicked image.
  await openPreviewFromFolderRow(page, 'lightbox-delta.png')
  await expect(page.getByTestId('lightbox-toolbar')).toBeVisible()

  const panel = page.getByTestId('lightbox-info-panel')
  await page.getByTestId('lightbox-info-toggle').click()
  await expect(panel).toBeVisible()
  await expect(panel.getByText('lightbox-delta.png')).toBeVisible()

  // Forward traversal follows folder order across all three slides, then
  // wraps (carousel is finite: false).
  await page.getByTestId('lightbox-next').click()
  await expect(panel.getByText('lightbox-epsilon.png')).toBeVisible()
  await page.getByTestId('lightbox-next').click()
  await expect(panel.getByText('lightbox-zeta.png')).toBeVisible()
  await page.getByTestId('lightbox-next').click()
  await expect(panel.getByText('lightbox-delta.png')).toBeVisible()

  // Backward traversal mirrors it.
  await page.getByTestId('lightbox-prev').click()
  await expect(panel.getByText('lightbox-zeta.png')).toBeVisible()

  // Images from other folders never appear in the folder carousel.
  for (const other of [
    'lightbox-alpha.png',
    'lightbox-beta.png',
    'lightbox-gamma.png',
  ]) {
    await expect(panel.getByText(other)).toHaveCount(0)
  }

  await page.getByTestId('lightbox-close').click()
  await expect(page.getByTestId('lightbox-toolbar')).toHaveCount(0)
})
