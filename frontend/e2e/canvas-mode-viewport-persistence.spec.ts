import type { Viewport } from '@xyflow/react'
import { legacyServiceCall } from './legacy-service'
import { expect, test } from './test-fixtures'
import { fixturePath, openFixtureRepo } from './test-helpers'

const repositoryViewport = { x: -341, y: 127, zoom: 1.35 }

const scenarios: {
  name: string
  view: Viewport | null
  edit: Viewport | null
}[] = [
  { name: 'neither mode saved', view: null, edit: null },
  { name: 'only View saved', view: { x: -70, y: 41, zoom: 1.8 }, edit: null },
  { name: 'only Edit saved', view: null, edit: { x: 82, y: -56, zoom: 0.9 } },
  {
    name: 'both modes saved',
    view: { x: -110, y: 28, zoom: 1.6 },
    edit: { x: 55, y: 94, zoom: 0.7 },
  },
]

for (const scenario of scenarios) {
  test(`mode viewports use independent repository fallback when ${scenario.name}`, async ({
    page,
  }) => {
    await openFixtureRepo(page, 'media-fixtures')
    const repoPath = await fixturePath('media-fixtures')
    await setRepositoryViewport(page, repoPath, repositoryViewport)
    await expectRepositoryViewport(page, repoPath, repositoryViewport)
    await setModeViewports(page, repoPath, scenario.view, scenario.edit)

    await page.reload()
    await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expectViewport(page, scenario.view ?? repositoryViewport)

    await page.getByTestId('canvas-mode-edit').click()
    await expect(page.getByTestId('canvas-mode-edit')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expectViewport(page, scenario.edit ?? repositoryViewport)
  })
}

test('mode viewport values stay isolated when switching repositories', async ({
  page,
}) => {
  const firstViewport = { x: -210, y: 61, zoom: 1.45 }
  const firstEditViewport = { x: 115, y: -43, zoom: 0.82 }
  const secondRepositoryViewport = { x: 238, y: -172, zoom: 1.22 }

  await openFixtureRepo(page, 'media-fixtures')
  const firstRepo = await fixturePath('media-fixtures')
  await setRepositoryViewport(page, firstRepo, repositoryViewport)
  await expectRepositoryViewport(page, firstRepo, repositoryViewport)
  await setModeViewports(page, firstRepo, firstViewport, firstEditViewport)

  await openFixtureRepo(page, 'sources-nav-fixtures')
  const secondRepo = await fixturePath('sources-nav-fixtures')
  await setRepositoryViewport(page, secondRepo, secondRepositoryViewport)
  await page.reload()
  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expectViewport(page, secondRepositoryViewport)
  await page.getByTestId('canvas-mode-edit').click()
  await expect(page.getByTestId('canvas-mode-edit')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expectViewport(page, secondRepositoryViewport)

  await openFixtureRepo(page, 'media-fixtures')
  await page.reload()
  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expectViewport(page, firstViewport)
  await page.getByTestId('canvas-mode-edit').click()
  await expect(page.getByTestId('canvas-mode-edit')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expectViewport(page, firstEditViewport)
})

test('a user wheel viewport survives reload', async ({ page }) => {
  await openFixtureRepo(page, 'media-fixtures')
  const repoPath = await fixturePath('media-fixtures')
  await page.evaluate((path) => {
    for (const mode of ['view', 'edit'])
      localStorage.removeItem(
        `loom.canvas.viewport.v1:${encodeURIComponent(path)}:${mode}`
      )
  }, repoPath)
  await page.reload()
  const pane = page.locator('.react-flow__pane')
  await pane.waitFor()
  const box = await pane.boundingBox()
  if (!box) throw new Error('Canvas pane is not visible')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(140, 95)
  const key = `loom.canvas.viewport.v1:${encodeURIComponent(repoPath)}:view`
  await expect
    .poll(() =>
      page.evaluate((storageKey) => localStorage.getItem(storageKey), key)
    )
    .not.toBeNull()
  const stored = await page.evaluate((storageKey) => {
    const value = localStorage.getItem(storageKey)
    return value ? (JSON.parse(value) as Viewport) : null
  }, key)
  if (!stored) throw new Error('User viewport was not persisted')
  await expectViewport(page, stored)

  await page.reload()
  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expectViewport(page, stored)
})

test('a delayed wheel end cannot cross a mode switch or replace a newer gesture', async ({
  page,
}) => {
  const viewStart = { x: -145, y: 62, zoom: 1.3 }
  const editStart = { x: 90, y: -35, zoom: 0.85 }
  await openFixtureRepo(page, 'media-fixtures')
  const repoPath = await fixturePath('media-fixtures')
  await setModeViewports(page, repoPath, viewStart, editStart)
  await page.reload()
  await expectViewport(page, viewStart)
  await page.clock.install()

  const pane = page.locator('.react-flow__pane')
  const box = await pane.boundingBox()
  if (!box) throw new Error('Canvas pane is not visible')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(105, 58)
  await expect.poll(() => readRenderedViewport(page)).not.toEqual(viewStart)
  const acceptedView = await readRenderedViewport(page)

  await page.getByTestId('canvas-mode-edit').click()
  await expectViewport(page, editStart)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(-75, 44)
  await expect.poll(() => readRenderedViewport(page)).not.toEqual(editStart)
  const acceptedEdit = await readRenderedViewport(page)
  await page.clock.fastForward(200)
  await expectViewport(page, acceptedEdit)
  expectViewportClose(
    await readStoredModeViewport(page, repoPath, 'view'),
    acceptedView
  )
  expectViewportClose(
    await readStoredModeViewport(page, repoPath, 'edit'),
    acceptedEdit
  )

  await page.reload()
  await expectViewport(page, acceptedView)
  await page.getByTestId('canvas-mode-edit').click()
  await expectViewport(page, acceptedEdit)
})

async function setRepositoryViewport(
  page: Parameters<typeof openFixtureRepo>[0],
  repoPath: string,
  viewport: Viewport
) {
  await legacyServiceCall(page, 'imageservice.ts', 'SetViewport', [
    repoPath,
    viewport,
  ])
}

async function expectRepositoryViewport(
  page: Parameters<typeof openFixtureRepo>[0],
  repoPath: string,
  expected: Viewport
) {
  const actual = await legacyServiceCall<Viewport | null>(
    page,
    'imageservice.ts',
    'GetViewport',
    [repoPath]
  )
  expect(actual).toEqual(expected)
}

async function setModeViewports(
  page: Parameters<typeof openFixtureRepo>[0],
  repoPath: string,
  view: Viewport | null,
  edit: Viewport | null
) {
  await page.evaluate(
    ({ path, viewViewport, editViewport }) => {
      for (const mode of ['view', 'edit']) {
        const key = `loom.canvas.viewport.v1:${encodeURIComponent(path)}:${mode}`
        window.localStorage.removeItem(key)
      }
      if (viewViewport) {
        const key = `loom.canvas.viewport.v1:${encodeURIComponent(path)}:view`
        window.localStorage.setItem(key, JSON.stringify(viewViewport))
      }
      if (editViewport) {
        const key = `loom.canvas.viewport.v1:${encodeURIComponent(path)}:edit`
        window.localStorage.setItem(key, JSON.stringify(editViewport))
      }
    },
    { path: repoPath, viewViewport: view, editViewport: edit }
  )
}

async function expectViewport(
  page: Parameters<typeof openFixtureRepo>[0],
  expected: Viewport
) {
  await expect
    .poll(async () => {
      const actual = await page
        .locator('.react-flow__viewport')
        .evaluate((node) => {
          const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform)
          return { x: matrix.m41, y: matrix.m42, zoom: matrix.a }
        })
      return Math.max(
        Math.abs(actual.x - expected.x),
        Math.abs(actual.y - expected.y),
        Math.abs(actual.zoom - expected.zoom)
      )
    })
    .toBeLessThan(0.02)
}

async function readRenderedViewport(
  page: Parameters<typeof openFixtureRepo>[0]
) {
  return page.locator('.react-flow__viewport').evaluate((node) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform)
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.a }
  })
}

async function readStoredModeViewport(
  page: Parameters<typeof openFixtureRepo>[0],
  repoPath: string,
  mode: 'view' | 'edit'
) {
  const key = `loom.canvas.viewport.v1:${encodeURIComponent(repoPath)}:${mode}`
  return page.evaluate((storageKey) => {
    const value = localStorage.getItem(storageKey)
    return value ? (JSON.parse(value) as Viewport) : null
  }, key)
}

function expectViewportClose(actual: Viewport | null, expected: Viewport) {
  expect(actual).not.toBeNull()
  if (!actual) return
  expect(
    Math.max(
      Math.abs(actual.x - expected.x),
      Math.abs(actual.y - expected.y),
      Math.abs(actual.zoom - expected.zoom)
    )
  ).toBeLessThan(0.02)
}
