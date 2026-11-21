import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, type Locator, type Page } from '@playwright/test'
import { getE2ERunId } from './run-context'

const runId = getE2ERunId()
const runDir = path.resolve(
  import.meta.dirname,
  `../../.cache/e2e/runs/${runId}`
)
const fixtureRootFile = path.join(runDir, 'fixture-root.json')
const fixtureAttemptFile = path.join(
  runDir,
  `fixture-attempt-${process.env.TEST_PARALLEL_INDEX ?? '0'}.json`
)

async function fixtureRoots() {
  const roots = JSON.parse(await readFile(fixtureRootFile, 'utf8')) as {
    browseRoot: string
    configRoot: string
  }
  const { attemptDirectory } = JSON.parse(
    await readFile(fixtureAttemptFile, 'utf8')
  ) as { attemptDirectory: string }
  return { ...roots, attemptDirectory }
}

export async function fixtureConfigPath(...segments: string[]) {
  const { configRoot } = await fixtureRoots()
  return path.join(configRoot, ...segments)
}

export async function fixturePath(repoName: string, ...segments: string[]) {
  const { browseRoot, attemptDirectory } = await fixtureRoots()
  return path.join(browseRoot, attemptDirectory, repoName, ...segments)
}

export async function enterFixtureAttemptFolder(picker: Locator) {
  const { attemptDirectory } = await fixtureRoots()
  await picker
    .getByRole('button', { name: attemptDirectory, exact: true })
    .click()
}

export async function openFixtureRepo(
  page: Page,
  repoName: string,
  options: { drawers?: 'both' | 'closed' | 'assets' | 'inspector' } = {}
) {
  await page.goto('/')
  await expect(page).toHaveTitle('Loom')

  const openButton = page
    .getByRole('button', { name: /^(Create New Repo|New Repo)$/ })
    .first()
  await openButton.click()

  const picker = page.getByRole('dialog')
  await expect(picker).toBeVisible()
  await enterFixtureAttemptFolder(picker)
  await picker
    .getByRole('button', { name: new RegExp(`^${repoName}(?:\\s+repo)?$`) })
    .click()
  await picker
    .getByRole('button', { name: /^(Create repo here|Open this folder)$/ })
    .click()

  await expect(page).toHaveURL(/\/canvas$/)
  await expect(page.getByRole('heading', { name: 'Canvas' })).toBeVisible()
  await expect(page.locator('.react-flow')).toBeVisible()
  const drawers = options.drawers ?? 'both'
  if (drawers === 'both' || drawers === 'assets')
    await page.getByTestId('toggle-assets-shelf').click()
  if (drawers === 'both' || drawers === 'inspector')
    await page.getByTestId('toggle-inspector-shelf').click()
}

export async function autoArrangeCanvas(page: Page) {
  const subgraphAction = page.getByTestId('dock-arrange-selection')
  if (await subgraphAction.isVisible()) {
    await subgraphAction.click()
    await waitForStableNodePositions(page)
    return
  }
  const canvasAction = page.getByTestId('dock-auto-arrange')
  if (!(await canvasAction.isVisible())) {
    await page
      .locator('.react-flow__pane')
      .click({ position: { x: 600, y: 400 } })
  }
  await canvasAction.click()
  await waitForStableNodePositions(page)
}

// Layout actions can animate the viewport, so a node's screen box read right
// after the action may be stale by the time a pointer gesture uses it.
export async function waitForStableNodePositions(page: Page) {
  const positions = () =>
    page.locator('.react-flow__node').evaluateAll((elements) =>
      elements
        .map((element) => {
          const rect = element.getBoundingClientRect()
          return `${Math.round(rect.x)},${Math.round(rect.y)}`
        })
        .join('|')
    )
  await expect
    .poll(
      async () => {
        const before = await positions()
        await page.waitForTimeout(120)
        return before === (await positions())
      },
      { timeout: 5_000 }
    )
    .toBe(true)
}

export function assets(page: Page) {
  return page.getByRole('listbox', { name: 'Assets' }).getByRole('option')
}

export function asset(page: Page, fileName: string) {
  return assets(page).filter({ hasText: fileName })
}

export async function openAssetsShelf(page: Page) {
  const drawer = page.locator('aside[aria-label="Assets"]')
  if ((await drawer.getAttribute('data-visible')) === 'true') return
  await page.getByTestId('toggle-assets-shelf').click()
  await expect(drawer).toHaveAttribute('data-visible', 'true')
}

export function imageNodes(page: Page) {
  return page.locator('.react-flow__node-image')
}

export async function dropAsset(
  page: Page,
  fileName: string,
  targetPosition: { x: number; y: number }
) {
  return dropAssetRow(page, asset(page, fileName), targetPosition)
}

export async function dropAssetRow(
  page: Page,
  source: Locator,
  targetPosition: { x: number; y: number }
) {
  const drawer = page.locator('aside[aria-label="Assets"]')
  await openAssetsShelf(page)
  await expect(source).toHaveCount(1)
  const pane = page.locator('.react-flow__pane')
  const paneBox = await pane.boundingBox()
  const drawerBox = (await drawer.isVisible())
    ? await drawer.boundingBox()
    : null
  const safeX =
    paneBox &&
    drawerBox &&
    paneBox.x + targetPosition.x < drawerBox.x + drawerBox.width
      ? targetPosition.x + drawerBox.width + 24
      : targetPosition.x
  await source.dragTo(pane, {
    targetPosition: { x: safeX, y: targetPosition.y },
  })
  if (
    (await page.getByTestId('pin-shelf-left').getAttribute('aria-pressed')) !==
    'true'
  ) {
    await expect(drawer).toHaveAttribute('data-state', 'closed')
  }
}

export async function placeAssets(
  page: Page,
  fileNames: string[],
  start = { x: 100, y: 100 }
) {
  for (const [index, fileName] of fileNames.entries()) {
    await dropAsset(page, fileName, {
      x: start.x + index * 220,
      y: start.y + (index % 2) * 120,
    })
  }
  await expect(imageNodes(page)).toHaveCount(fileNames.length)
}

export async function selectImageNodes(page: Page, indexes: number[]) {
  for (const [position, index] of indexes.entries()) {
    await imageNodes(page)
      .nth(index)
      .click(
        position === 0
          ? { position: { x: 20, y: 20 } }
          : { modifiers: ['Shift'], position: { x: 20, y: 20 } }
      )
  }
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(
    indexes.length
  )
}

export async function nodeBox(node: Locator) {
  const box = await node.boundingBox()
  if (!box) throw new Error('node has no bounding box')
  return box
}

export async function ctrlDrag(page: Page, source: Locator, target: Locator) {
  const sourceBox = await nodeBox(source)
  const targetBox = await nodeBox(target)
  await page.keyboard.down('Control')
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 8 }
  )
  await page.mouse.up()
  await page.keyboard.up('Control')
}
