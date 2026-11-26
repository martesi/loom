import { readdir } from 'node:fs/promises'
import type { Locator, Page } from '@playwright/test'
import type {
  CanvasData,
  UndoState,
} from '../bindings/loom/internal/service/models'
import { runtimeMethodID } from './bindings'
import { legacyServiceCall } from './legacy-service'
import { expect, test } from './test-fixtures'
import {
  asset,
  autoArrangeCanvas,
  fixturePath,
  imageNodes,
  nodeBox,
  openAssetsShelf,
  openFixtureRepo,
  placeAssets,
} from './test-helpers'

const importMediaMethodID = runtimeMethodID('imageservice.ts', 'ImportMedia')
const loadCanvasMethodID = runtimeMethodID('imageservice.ts', 'LoadCanvas')
const getLayoutSnapshotMethodID = runtimeMethodID(
  'imageservice.ts',
  'GetLayoutSnapshot'
)

function waitForRuntimeCall(page: Page, methodID: string) {
  return page.waitForResponse(
    (response) =>
      response.url().includes('/wails/runtime') &&
      response.request().postData()?.includes(`"methodID":${methodID}`) === true
  )
}

async function dragBy(page: Page, locator: Locator, dx: number, dy: number) {
  const box = await nodeBox(locator)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    box.x + box.width / 2 + dx,
    box.y + box.height / 2 + dy,
    { steps: 8 }
  )
  await page.mouse.up()
}

test('node resize and movement persist while Space drag pans instead of moving nodes', async ({
  page,
}) => {
  await openFixtureRepo(page, 'resize-fixtures')
  await placeAssets(page, ['resize-alpha.png'])
  const node = imageNodes(page).first()
  await node.click()

  const beforeResize = await nodeBox(node)
  const handle = node.getByTestId('resize-handle-se')
  await expect(handle).toBeVisible()
  await dragBy(page, handle, 60, 40)
  await expect
    .poll(async () => (await nodeBox(node)).width)
    .toBeGreaterThan(beforeResize.width + 30)
  const resized = await nodeBox(node)

  await dragBy(page, node, 100, 60)
  const moved = await nodeBox(node)
  expect(moved.x).toBeGreaterThan(resized.x + 50)

  await page.reload()
  const restored = imageNodes(page).first()
  await expect(restored).toBeVisible()
  const restoredBox = await nodeBox(restored)
  expect(Math.abs(restoredBox.width - resized.width)).toBeLessThan(5)
  expect(Math.abs(restoredBox.x - moved.x)).toBeLessThan(15)

  await restored.click()
  const nodeTransform = await restored.evaluate(
    (element) => (element as HTMLElement).style.transform
  )
  const viewport = page.locator('.react-flow__viewport')
  const viewportTransform = await viewport.getAttribute('style')
  await page.keyboard.down('Space')
  await dragBy(page, restored, 120, 60)
  await page.keyboard.up('Space')
  await expect
    .poll(() =>
      restored.evaluate((element) => (element as HTMLElement).style.transform)
    )
    .toBe(nodeTransform)
  await expect(viewport).not.toHaveAttribute('style', viewportTransform ?? '')
})

test('text-input undo does not undo canvas changes', async ({ page }) => {
  await openFixtureRepo(page, 'shortcut-fixtures')
  await placeAssets(page, ['shortcut-alpha.png', 'shortcut-beta.png'])
  await autoArrangeCanvas(page)
  const positions = () =>
    imageNodes(page).evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).style.transform)
    )
  const arranged = await positions()
  await openAssetsShelf(page)
  const search = page.getByRole('textbox', { name: 'Search assets' })
  await search.pressSequentially('shortcut')
  await search.press('ControlOrMeta+z')
  await expect(search).not.toHaveValue('shortcut')
  await expect(imageNodes(page)).toHaveCount(2)
  expect(await positions()).toEqual(arranged)
  await page.reload()
  await expect(imageNodes(page)).toHaveCount(2)
})

test('file drop and canvas clipboard paste create placed assets and errors are dismissible', async ({
  page,
  context,
  clipboardAccess,
}) => {
  void clipboardAccess
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openFixtureRepo(page, 'media-fixtures')
  let importCalls = 0
  let reconciliationLoads = 0
  page.on('request', (request) => {
    if (!request.url().includes('/wails/runtime')) return
    const body = request.postData() ?? ''
    if (body.includes(`"methodID":${importMediaMethodID}`)) importCalls++
    if (
      body.includes(`"methodID":${loadCanvasMethodID}`) ||
      body.includes(`"methodID":${getLayoutSnapshotMethodID}`)
    )
      reconciliationLoads++
  })

  const dropImport = waitForRuntimeCall(page, importMediaMethodID)
  const dropLoad = waitForRuntimeCall(page, loadCanvasMethodID)
  const dropSnapshot = waitForRuntimeCall(page, getLayoutSnapshotMethodID)
  await page.evaluate(() => {
    const encoded =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }))
    const canvas = document.querySelector<HTMLElement>(
      'main[aria-label="Canvas"]'
    )
    if (!canvas) throw new Error('Canvas not found')
    const rect = canvas.getBoundingClientRect()
    canvas.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      })
    )
  })
  await Promise.all([dropImport, dropLoad, dropSnapshot])

  await expect(asset(page, 'dropped.png')).toBeVisible()
  await expect(imageNodes(page)).toHaveCount(1)

  await imageNodes(page).first().click()
  await page.evaluate(async () => {
    const data =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    await navigator.clipboard.writeText(
      JSON.stringify({
        version: 1,
        media: [{ name: 'canvas-paste.png', data }],
      })
    )
  })
  const firstPasteImport = waitForRuntimeCall(page, importMediaMethodID)
  const firstPasteLoad = waitForRuntimeCall(page, loadCanvasMethodID)
  const firstPasteSnapshot = waitForRuntimeCall(page, getLayoutSnapshotMethodID)
  await page.keyboard.press('Control+v')
  await Promise.all([firstPasteImport, firstPasteLoad, firstPasteSnapshot])
  await expect(imageNodes(page)).toHaveCount(2)

  const sourceAsset = asset(page, 'media-alpha.png')
  await sourceAsset.click()
  await expect(sourceAsset).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Control+Shift+c')
  // Copy-converted has no converter in this build. It must report that and
  // leave the existing clipboard payload intact so the next paste still works.
  const convertedError = page.getByRole('alert')
  await expect(convertedError).toContainText(
    'Converted copy is unavailable. No converter is installed.'
  )
  await convertedError.getByRole('button', { name: 'Dismiss' }).click()
  await expect(convertedError).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('canvas-paste.png')
  const secondPasteImport = waitForRuntimeCall(page, importMediaMethodID)
  const secondPasteLoad = waitForRuntimeCall(page, loadCanvasMethodID)
  const secondPasteSnapshot = waitForRuntimeCall(
    page,
    getLayoutSnapshotMethodID
  )
  await page.keyboard.press('Control+v')
  await Promise.all([secondPasteImport, secondPasteLoad, secondPasteSnapshot])
  await expect(asset(page, 'canvas-paste.png')).toBeVisible()

  const repoPath = await fixturePath('media-fixtures')
  const repositoryBefore = await legacyServiceCall<CanvasData | null>(
    page,
    'imageservice.ts',
    'LoadCanvas',
    [repoPath]
  )
  const historyBefore = await legacyServiceCall<UndoState | null>(
    page,
    'undoservice.ts',
    'State',
    [repoPath]
  )
  const filesBefore = (await readdir(repoPath)).sort()
  const importsBeforeInvalidPaste = importCalls
  const reloadsBeforeInvalidPaste = reconciliationLoads
  await page.evaluate(() => navigator.clipboard.writeText('not Loom media'))
  await page.keyboard.press('Control+v')
  const pasteError = page.getByRole('alert')
  await expect(pasteError).toContainText('Clipboard contains no media files')
  await pasteError.getByRole('button', { name: 'Dismiss' }).click()
  await expect(pasteError).toHaveCount(0)
  expect(importCalls).toBe(importsBeforeInvalidPaste)
  expect(reconciliationLoads).toBe(reloadsBeforeInvalidPaste)
  expect(
    await legacyServiceCall<CanvasData | null>(
      page,
      'imageservice.ts',
      'LoadCanvas',
      [repoPath]
    )
  ).toEqual(repositoryBefore)
  expect(
    await legacyServiceCall<UndoState | null>(page, 'undoservice.ts', 'State', [
      repoPath,
    ])
  ).toEqual(historyBefore)
  expect((await readdir(repoPath)).sort()).toEqual(filesBefore)
})

test('lost import response keeps the real repository fenced after later reads', async ({
  page,
  context,
  clipboardAccess,
}) => {
  void clipboardAccess
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openFixtureRepo(page, 'media-fixtures')
  let importCalls = 0
  await page.route('**/wails/runtime', async (route) => {
    if (
      route.request().postData()?.includes(`"methodID":${importMediaMethodID}`)
    ) {
      importCalls++
      const response = await route.fetch()
      if (importCalls === 1) {
        await route.abort('failed')
        return
      }
      await route.fulfill({ response })
      return
    }
    await route.continue()
  })

  await page.evaluate(async () => {
    const data =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    await navigator.clipboard.writeText(
      JSON.stringify({
        version: 1,
        media: [{ name: 'lost-response.png', data }],
      })
    )
  })
  await page.keyboard.press('Control+v')
  const issue = page.getByRole('alert')
  await expect(issue).toContainText('Repository state is unknown')
  expect(importCalls).toBe(1)

  const repoPath = await fixturePath('media-fixtures')
  const firstRead = await legacyServiceCall<CanvasData | null>(
    page,
    'imageservice.ts',
    'LoadCanvas',
    [repoPath]
  )
  expect(
    firstRead?.images?.some((image) => image.fileName === 'lost-response.png')
  ).toBe(true)
  await legacyServiceCall<CanvasData | null>(
    page,
    'imageservice.ts',
    'LoadCanvas',
    [repoPath]
  )
  await legacyServiceCall<UndoState | null>(page, 'undoservice.ts', 'State', [
    repoPath,
  ])

  await page.evaluate(async () => {
    const data =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    await navigator.clipboard.writeText(
      JSON.stringify({
        version: 1,
        media: [{ name: 'must-not-retry.png', data }],
      })
    )
  })
  await page.keyboard.press('Control+v')
  await expect(page.getByRole('alert')).toContainText(
    'Repository state is unknown'
  )
  expect(importCalls).toBe(1)
  const finalRead = await legacyServiceCall<CanvasData | null>(
    page,
    'imageservice.ts',
    'LoadCanvas',
    [repoPath]
  )
  expect(
    finalRead?.images?.some((image) => image.fileName === 'must-not-retry.png')
  ).toBe(false)
})

test('settled import reconciles but does not replace a newer Assets selection', async ({
  page,
  context,
  clipboardAccess,
}) => {
  void clipboardAccess
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openFixtureRepo(page, 'media-fixtures')
  const seedImport = waitForRuntimeCall(page, importMediaMethodID)
  const seedLoad = waitForRuntimeCall(page, loadCanvasMethodID)
  const seedSnapshot = waitForRuntimeCall(page, getLayoutSnapshotMethodID)
  await page.evaluate(() => {
    const encoded =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(
      new File([bytes], 'selection-seed.png', { type: 'image/png' })
    )
    const canvas = document.querySelector<HTMLElement>(
      'main[aria-label="Canvas"]'
    )
    if (!canvas) throw new Error('Canvas not found')
    const rect = canvas.getBoundingClientRect()
    canvas.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      })
    )
  })
  await Promise.all([seedImport, seedLoad, seedSnapshot])
  await openAssetsShelf(page)
  await asset(page, 'media-alpha.png').click()
  let releaseResponse!: () => void
  let signalBackendComplete!: () => void
  const backendComplete = new Promise<void>((resolve) => {
    signalBackendComplete = resolve
  })
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  await page.route('**/wails/runtime', async (route) => {
    if (
      !route.request().postData()?.includes(`"methodID":${importMediaMethodID}`)
    ) {
      await route.continue()
      return
    }
    const response = await route.fetch()
    signalBackendComplete()
    await responseGate
    await route.fulfill({ response })
  })
  await page.evaluate(async () => {
    const data =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    await navigator.clipboard.writeText(
      JSON.stringify({
        version: 1,
        media: [{ name: 'settled-response.png', data }],
      })
    )
  })
  await page.keyboard.press('Control+v')
  await backendComplete
  const newerSelection = asset(page, 'selection-seed.png')
  await newerSelection.click()
  await expect(newerSelection).toHaveAttribute('aria-selected', 'true')
  const reconcileLoad = waitForRuntimeCall(page, loadCanvasMethodID)
  const reconcileSnapshot = waitForRuntimeCall(page, getLayoutSnapshotMethodID)
  releaseResponse()
  await Promise.all([reconcileLoad, reconcileSnapshot])
  await expect(asset(page, 'settled-response.png')).toBeVisible()
  await expect(newerSelection).toHaveAttribute('aria-selected', 'true')
})

test('stale file-drop preparation does not dispatch an import to the real backend', async ({
  page,
}) => {
  await openFixtureRepo(page, 'media-fixtures')
  await openAssetsShelf(page)
  let importCalls = 0
  page.on('request', (request) => {
    if (
      request.url().includes('/wails/runtime') &&
      request.postData()?.includes(`"methodID":${importMediaMethodID}`)
    )
      importCalls++
  })
  const repoPath = await fixturePath('media-fixtures')
  const filesBefore = (await readdir(repoPath)).sort()
  await page.evaluate(() => {
    let release!: () => void
    let started!: () => void
    let finished!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const readStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const readFinished = new Promise<void>((resolve) => {
      finished = resolve
    })
    const original = FileReader.prototype.readAsDataURL
    FileReader.prototype.readAsDataURL = function (blob: Blob) {
      started()
      this.addEventListener('loadend', () => finished(), { once: true })
      void gate.then(() => original.call(this, blob))
    }
    Object.assign(window, {
      __dropReadStarted: readStarted,
      __releaseDropRead: release,
      __dropReadFinished: readFinished,
    })
  })
  await page.evaluate(() => {
    const encoded =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(
      new File([bytes], 'stale-drop.png', { type: 'image/png' })
    )
    const canvas = document.querySelector<HTMLElement>(
      'main[aria-label="Canvas"]'
    )
    if (!canvas) throw new Error('Canvas not found')
    const rect = canvas.getBoundingClientRect()
    canvas.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      })
    )
  })
  await page.evaluate(async () => {
    await (Reflect.get(window, '__dropReadStarted') as Promise<void>)
  })
  await asset(page, 'media-alpha.png').click()
  await page.evaluate(() => {
    ;(Reflect.get(window, '__releaseDropRead') as () => void)()
  })
  await page.evaluate(async () => {
    await (Reflect.get(window, '__dropReadFinished') as Promise<void>)
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  })
  expect(importCalls).toBe(0)
  expect((await readdir(repoPath)).sort()).toEqual(filesBefore)
})
