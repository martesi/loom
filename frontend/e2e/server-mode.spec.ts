import { expect, test } from '@playwright/test'
import {
  canvasNode,
  closeContextMenu,
  createBoard,
  dragLibraryImageToCanvas,
  expectCanvasNodeGeometry,
  expectMenuShortcut,
  explorerFile,
  menuItem,
  openExplorer,
  openFixtureRepo,
  openLibraryRowContextMenu,
  openNodeContextMenu,
  openPaneContextMenu,
  reloadBoard,
  selectCanvasNodes,
  waitForCanvasNodeCount,
} from './test-helpers'

const token =
  process.env.E2E_TOKEN ?? process.env.LOOM_TOKEN ?? 'loom-e2e-token'

test('server mode authenticates and bootstraps a first board', async ({
  page,
  request,
}) => {
  const health = await request.get('/health')
  expect(health.status()).toBe(200)
  expect(await health.json()).toEqual({ status: 'ok' })

  const unauthenticated = await request.get('/')
  expect(unauthenticated.status()).toBe(401)

  const invalidToken = await request.get(
    `/?token=${encodeURIComponent('invalid-e2e-token')}`
  )
  expect(invalidToken.status()).toBe(401)

  const unauthenticatedRPC = await request.post('/wails/runtime', {
    data: { object: 0, method: 0, args: [] },
  })
  expect(unauthenticatedRPC.status()).toBe(401)

  const invalidTokenRPC = await request.post(
    '/wails/runtime?token=invalid-e2e-token',
    { data: { object: 0, method: 0, args: [] } }
  )
  expect(invalidTokenRPC.status()).toBe(401)

  await page.goto(`/?token=${encodeURIComponent(token)}`)
  await expect(page).toHaveTitle('Loom')

  const finalURL = new URL(page.url())
  expect(finalURL.pathname).toBe('/')
  expect(finalURL.searchParams.has('token')).toBe(false)

  const loomCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'loom_token'
  )
  expect(loomCookie?.value).toBe(token)
  expect(loomCookie?.httpOnly).toBe(true)

  await expect(
    page.getByRole('heading', { name: 'Welcome to Loom' })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Create New Repo' }).click()

  const picker = page.getByRole('dialog')
  await expect(picker.getByText('Choose a folder')).toBeVisible()
  await expect(
    picker.getByRole('button', { name: 'e2e-repo', exact: true })
  ).toBeVisible()
  await picker.getByRole('button', { name: 'e2e-repo', exact: true }).click()
  await picker
    .getByRole('button', { name: 'Create repo here', exact: true })
    .click()

  await expect(page.getByText('No boards yet')).toBeVisible()
  await page.getByRole('button', { name: 'Create board', exact: true }).click()

  await expect(page.getByRole('button', { name: /^Board 1/ })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Library', exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Explorer', exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Detail', exact: true })
  ).toBeVisible()
  await expect(page.locator('.react-flow')).toBeVisible()
})

test('initial and grouped nodes stay visible with concrete sizes after reload', async ({
  page,
}) => {
  await openFixtureRepo(page, 'canvas-fixtures')
  await createBoard(page)

  const first = await dragLibraryImageToCanvas(page, 'canvas-alpha.png', {
    x: 700,
    y: 180,
  })
  await expectCanvasNodeGeometry(first)

  await dragLibraryImageToCanvas(page, 'canvas-beta.png', {
    x: 900,
    y: 360,
  })
  await selectCanvasNodes(page, [0, 1])
  const groupButton = page.getByRole('button', {
    name: 'Group selected images as a set',
  })
  await expect(groupButton).toBeEnabled()
  await groupButton.click()

  await waitForCanvasNodeCount(page, 1)
  await expectCanvasNodeGeometry(canvasNode(page))
  await reloadBoard(page)
  await waitForCanvasNodeCount(page, 1)
  await expectCanvasNodeGeometry(canvasNode(page))
})

test('Delete and Backspace remove a node from the board without trashing it', async ({
  page,
}) => {
  await openFixtureRepo(page, 'remove-fixtures')
  await createBoard(page)

  const fileName = 'remove-me.png'
  const first = await dragLibraryImageToCanvas(page, fileName)
  await first.click()
  await page.keyboard.press('Delete')
  await waitForCanvasNodeCount(page, 0)

  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await expect(
    page.locator('tbody tr').filter({ hasText: fileName })
  ).toBeVisible()

  const second = await dragLibraryImageToCanvas(page, fileName)
  await second.click()
  await page.keyboard.press('Backspace')
  await waitForCanvasNodeCount(page, 0)
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await expect(
    page.locator('tbody tr').filter({ hasText: fileName })
  ).toBeVisible()
})

test('the node context menu removes an image from the board and shows its Delete hint', async ({
  page,
}) => {
  await openFixtureRepo(page, 'context-menu-fixtures')
  await createBoard(page)

  const fileName = 'context-menu.png'
  const node = await dragLibraryImageToCanvas(page, fileName)
  const menu = await openNodeContextMenu(page, node)
  await expectMenuShortcut(menu, 'Remove from board', 'Del')
  await menuItem(menu, 'Remove from board').click()

  await waitForCanvasNodeCount(page, 0)
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await expect(
    page.locator('tbody tr').filter({ hasText: fileName })
  ).toBeVisible()
})

test('file names are off by default, appear on hover when enabled, and persist', async ({
  page,
}) => {
  await openFixtureRepo(page, 'filename-fixtures')
  await createBoard(page)

  const fileName = 'hover-target.png'
  const node = await dragLibraryImageToCanvas(page, fileName)
  await expect(node.getByText(fileName, { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog')
  const toggle = dialog.getByRole('checkbox', {
    name: 'Show file names on hover',
  })
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await expect(toggle).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  await node.hover()
  const filenameOverlay = node.getByText(fileName, { exact: true })
  await expect(filenameOverlay).toHaveCount(1)
  await expect
    .poll(() =>
      filenameOverlay.evaluate((element) => getComputedStyle(element).opacity)
    )
    .toBe('1')

  await reloadBoard(page)
  const reloadedNode = canvasNode(page)
  await reloadedNode.hover()
  const reloadedOverlay = reloadedNode.getByText(fileName, { exact: true })
  await expect(reloadedOverlay).toHaveCount(1)
  await expect
    .poll(() =>
      reloadedOverlay.evaluate((element) => getComputedStyle(element).opacity)
    )
    .toBe('1')
})

async function assertShortcutMenus(
  page: Parameters<typeof openFixtureRepo>[0],
  repoName: string,
  expected: { remove: string; group: string; undo: string; redo: string }
) {
  await openFixtureRepo(page, repoName)
  await createBoard(page)
  await dragLibraryImageToCanvas(page, 'menu-alpha.png', {
    x: 700,
    y: 180,
  })
  await dragLibraryImageToCanvas(page, 'menu-beta.png', {
    x: 900,
    y: 360,
  })

  let menu = await openNodeContextMenu(page, canvasNode(page, 0))
  await expectMenuShortcut(menu, 'Remove from board', expected.remove)
  await closeContextMenu(page)

  await selectCanvasNodes(page, [0, 1])
  menu = await openNodeContextMenu(page, canvasNode(page, 1))
  await expectMenuShortcut(menu, 'Group as set', expected.group)
  await expectMenuShortcut(menu, 'Remove from board', expected.remove)
  await closeContextMenu(page)

  menu = await openPaneContextMenu(page)
  await expectMenuShortcut(menu, 'Undo', expected.undo)
  await expectMenuShortcut(menu, 'Redo', expected.redo)
  await closeContextMenu(page)
}

test('node, multi-selection, and pane menus show Linux shortcut hints', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Linux x86_64',
    })
  })
  await assertShortcutMenus(page, 'menu-linux-fixtures', {
    remove: 'Del',
    group: 'CtrlG',
    undo: 'CtrlZ',
    redo: 'Ctrl+Shift+Z',
  })
})

test('node, multi-selection, and pane menus show simulated macOS hints', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    })
  })
  await assertShortcutMenus(page, 'menu-mac-fixtures', {
    remove: '⌫',
    group: '⌘G',
    undo: '⌘Z',
    redo: '⌘⇧Z',
  })
})

test('Explorer drops trashed rows after canvas and Library mutations', async ({
  page,
}) => {
  await openFixtureRepo(page, 'explorer-fixtures')
  await createBoard(page)

  const canvasFile = 'canvas-trash.png'
  const libraryFile = 'library-trash.png'
  await dragLibraryImageToCanvas(page, canvasFile, { x: 700, y: 180 })
  await dragLibraryImageToCanvas(page, libraryFile, { x: 900, y: 360 })

  const tree = await openExplorer(page)
  await expect(explorerFile(tree, canvasFile)).toBeVisible()
  await expect(explorerFile(tree, libraryFile)).toBeVisible()

  const canvasMenu = await openNodeContextMenu(page, canvasNode(page, 0))
  await menuItem(canvasMenu, 'Trash').click()
  await waitForCanvasNodeCount(page, 1)
  await expect(explorerFile(tree, canvasFile)).toHaveCount(0)
  await expect(explorerFile(tree, libraryFile)).toBeVisible()

  await page.getByRole('button', { name: 'Library', exact: true }).click()
  const libraryMenu = await openLibraryRowContextMenu(page, libraryFile)
  await menuItem(libraryMenu, 'Trash').click()
  await waitForCanvasNodeCount(page, 0)

  await page.getByRole('button', { name: 'Explorer', exact: true }).click()
  await expect(explorerFile(tree, libraryFile)).toHaveCount(0)
})
