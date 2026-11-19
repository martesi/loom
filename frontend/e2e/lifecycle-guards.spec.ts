import { expect, test } from './test-fixtures'
import {
  asset,
  assets,
  imageNodes,
  openAssetsShelf,
  openFixtureRepo,
  placeAssets,
} from './test-helpers'

test.describe('P0 lifecycle and selection guards', () => {
  test('Assets trash and restore preserve the exact asset; purge requires confirmation', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'inspector-fixtures')
    const target = asset(page, 'inspect-alpha.png')
    const survivor = asset(page, 'inspect-beta.png')

    await target.click()
    await page.keyboard.press('Delete')
    const trashDialog = page.getByRole('dialog', {
      name: 'Move 1 asset to trash?',
    })
    await expect(trashDialog).toBeVisible()
    await trashDialog.getByRole('button', { name: 'Move to trash' }).click()
    await expect(trashDialog).toHaveCount(0)
    await expect(target).toHaveCount(0)
    await openAssetsShelf(page)
    await page.getByRole('button', { name: /^Filters/ }).click()
    await page
      .getByRole('combobox', { name: 'Asset state' })
      .selectOption('trashed')
    const trashed = asset(page, 'inspect-alpha.png')
    await expect(trashed).toBeVisible()
    await trashed.click()
    await page.getByRole('button', { name: 'Restore from trash' }).click()
    await page
      .getByRole('combobox', { name: 'Asset state' })
      .selectOption('active')
    await expect(asset(page, 'inspect-alpha.png')).toBeVisible()
    await expect(survivor).toBeVisible()

    await asset(page, 'inspect-alpha.png').click()
    await page.keyboard.press('Shift+Delete')
    const dialog = page.getByRole('dialog', {
      name: 'Permanently delete 1 asset?',
    })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(asset(page, 'inspect-alpha.png')).toBeVisible()

    await asset(page, 'inspect-alpha.png').click()
    await page.keyboard.press('Shift+Delete')
    const purgeDialog = page.getByRole('dialog', {
      name: 'Permanently delete 1 asset?',
    })
    await expect(purgeDialog).toBeVisible()
    await purgeDialog.getByRole('button', { name: 'Permanently delete' }).click()
    await expect(asset(page, 'inspect-alpha.png')).toHaveCount(0)
    await expect(survivor).toBeVisible()
    await expect(page.locator('[data-asset-id]')).toHaveCount(1)
  })

  test('Assets range and toggle selection identify the selected rows', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'library-selection-fixtures')
    const selected = page.locator(
      '[role="listbox"][aria-label="Assets"] [role="option"][aria-selected="true"]'
    )
    await asset(page, 'root-alpha.png').click()
    await asset(page, 'root-beta.png').click({ modifiers: ['Shift'] })
    await expect(selected).toHaveCount(2)
    await expect(selected.filter({ hasText: 'root-alpha.png' })).toHaveCount(1)
    await expect(selected.filter({ hasText: 'root-beta.png' })).toHaveCount(1)
    await asset(page, 'root-beta.png').click({ modifiers: ['Control'] })
    await expect(selected).toHaveCount(1)
    await expect(selected.filter({ hasText: 'root-alpha.png' })).toHaveCount(1)
    await expect(selected.filter({ hasText: 'root-beta.png' })).toHaveCount(0)
  })

  test('modified Canvas marquee adds only the nodes inside its bounds', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-fixtures', { drawers: 'closed' })
    await placeAssets(page, ['dock-alpha.png', 'dock-beta.png'])
    const nodes = imageNodes(page)
    await nodes.first().click()
    const second = await nodes.nth(1).boundingBox()
    if (!second) throw new Error('second Canvas node has no bounding box')
    await page.keyboard.down('Shift')
    await page.mouse.move(second.x - 8, second.y - 8)
    await page.mouse.down()
    await page.mouse.move(
      second.x + second.width + 8,
      second.y + second.height + 8,
      {
        steps: 8,
      }
    )
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await expect(nodes.nth(0)).toHaveClass(/selected/)
    await expect(nodes.nth(1)).toHaveClass(/selected/)
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  })

  test('dragging a selected row transfers the selection to Canvas and does not hide mid-drag', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'dock-fixtures')
    const first = asset(page, 'dock-alpha.png')
    const second = asset(page, 'dock-beta.png')
    await first.click()
    await second.click({ modifiers: ['Control'] })
    const drawer = page.locator('aside[aria-label="Assets"]')
    await expect(drawer).toHaveAttribute('data-state', 'open')
    await first.dragTo(page.locator('.react-flow__pane'), {
      targetPosition: { x: 520, y: 220 },
    })
    // The grabbed row belongs to the multi-selection, so the shelf serializes
    // both selected IDs. Successful placement transfers ownership to Canvas.
    await expect(imageNodes(page)).toHaveCount(2)
    await expect(imageNodes(page).filter({ hasText: 'dock-alpha.png' })).toHaveCount(1)
    await expect(imageNodes(page).filter({ hasText: 'dock-beta.png' })).toHaveCount(1)
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
    await expect(drawer).toHaveAttribute('data-state', 'closed')
    await openAssetsShelf(page)
    await expect(
      assets(page).filter({ hasText: 'dock-alpha.png' })
    ).toHaveAttribute('aria-selected', 'false')
    await expect(
      assets(page).filter({ hasText: 'dock-beta.png' })
    ).toHaveAttribute('aria-selected', 'false')
  })
})
