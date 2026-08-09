import { expect, type Locator, type Page } from '@playwright/test'

const token =
  process.env.E2E_TOKEN ?? process.env.LOOM_TOKEN ?? 'loom-e2e-token'

export async function openFixtureRepo(page: Page, repoName: string) {
  await page.goto(`/?token=${encodeURIComponent(token)}`)
  await expect(page).toHaveTitle('Loom')

  const newRepo = page
    .getByRole('button', { name: /(?:Create New Repo|New Repo)/ })
    .first()
  await expect(newRepo).toBeVisible()
  await newRepo.click()

  const picker = page.getByRole('dialog')
  await expect(picker).toBeVisible()
  await picker.getByRole('button').filter({ hasText: repoName }).first().click()

  const openButton = picker.getByRole('button', {
    name: /(?:Create repo here|Open this folder)/,
  })
  await expect(openButton).toBeVisible()
  await openButton.click()

  await expect(page.getByText('No boards yet', { exact: true })).toBeVisible()
}

export async function createBoard(page: Page) {
  await page.getByRole('button', { name: 'Create board', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Board 1/ })).toBeVisible()
  await expect(page.locator('.react-flow')).toBeVisible()
}

export async function reloadBoard(page: Page) {
  await page.reload()
  await expect(page.getByRole('button', { name: /^Board 1/ })).toBeVisible()
  await expect(page.locator('.react-flow')).toBeVisible()
}

export function canvasNodes(page: Page) {
  return page.locator('.react-flow__node')
}

export function canvasNode(page: Page, index = 0) {
  return canvasNodes(page).nth(index)
}

export async function waitForCanvasNodeCount(page: Page, count: number) {
  await expect(canvasNodes(page)).toHaveCount(count)
}

export async function dragLibraryImageToCanvas(
  page: Page,
  fileName: string,
  targetPosition: { x: number; y: number } = { x: 700, y: 200 }
) {
  await page.getByRole('button', { name: 'Library', exact: true }).click()

  const source = page
    .locator('[draggable="true"]')
    .filter({ hasText: fileName })
  await expect(source).toHaveCount(1)
  await expect(source).toBeVisible()

  const before = await canvasNodes(page).count()
  const pane = page.locator('.react-flow__pane').first()
  await expect(pane).toBeVisible()
  await source.dragTo(pane, { targetPosition })

  await expect.poll(() => canvasNodes(page).count()).toBe(before + 1)
  return canvasNode(page, before)
}

export async function expectCanvasNodeGeometry(
  node: Locator,
  width = 150,
  height = 110
) {
  await expect(node).toBeVisible()
  await expect
    .poll(async () =>
      node.evaluate((element) => {
        const htmlElement = element as HTMLElement
        return {
          width: htmlElement.style.width,
          height: htmlElement.style.height,
        }
      })
    )
    .toEqual({ width: `${width}px`, height: `${height}px` })
}

export async function selectCanvasNodes(page: Page, indexes: number[]) {
  for (const [position, index] of indexes.entries()) {
    await canvasNode(page, index).click(
      position === 0 ? {} : { modifiers: ['Shift'] }
    )
  }
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(
    indexes.length
  )
}

export async function openNodeContextMenu(page: Page, node: Locator) {
  await node.click({ button: 'right' })
  const menu = page.getByRole('menu').last()
  await expect(menu).toBeVisible()
  return menu
}

export async function openLibraryRowContextMenu(page: Page, fileName: string) {
  const row = page.locator('tbody tr').filter({ hasText: fileName }).first()
  await expect(row).toBeVisible()
  await row.click({ button: 'right' })
  const menu = page.getByRole('menu').last()
  await expect(menu).toBeVisible()
  return menu
}

export async function openPaneContextMenu(page: Page) {
  const pane = page.locator('.react-flow__pane').first()
  await expect(pane).toBeVisible()
  await pane.click({
    button: 'right',
    position: { x: 700, y: 580 },
  })
  const menu = page.getByRole('menu').last()
  await expect(menu).toBeVisible()
  return menu
}

export function menuItem(menu: Locator, label: string) {
  return menu.getByRole('button').filter({ hasText: label }).first()
}

export async function expectMenuShortcut(
  menu: Locator,
  label: string,
  shortcut: string
) {
  const item = menuItem(menu, label)
  await expect(item).toBeVisible()
  await expect(item.locator('kbd[data-slot="kbd"]')).toHaveText(shortcut)
}

export async function closeContextMenu(page: Page) {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
}

export async function openExplorer(page: Page) {
  await page.getByRole('button', { name: 'Explorer', exact: true }).click()
  const tree = page.getByRole('tree', { name: 'File explorer' })
  await expect(tree).toBeVisible()
  return tree
}

export function explorerFile(tree: Locator, fileName: string) {
  return tree.getByRole('treeitem').filter({ hasText: fileName }).first()
}
