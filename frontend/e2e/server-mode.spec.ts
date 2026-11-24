import { readFile } from 'node:fs/promises'
import { expect, test } from './test-fixtures'
import {
  enterFixtureAttemptFolder,
  fixturePath,
  openFixtureRepo,
} from './test-helpers'

test('server health, folder picker navigation, recent repos, and reload restoration', async ({
  page,
  request,
}) => {
  const health = await request.get('/health')
  expect(health.status()).toBe(200)
  expect(await health.json()).toEqual({ status: 'ok' })

  await page.goto('/')
  await expect(page).toHaveTitle('Loom')
  await page
    .getByRole('button', { name: /^(Create New Repo|New Repo)$/ })
    .click()
  const picker = page.getByRole('dialog')
  await expect(picker).toBeVisible()
  await enterFixtureAttemptFolder(picker)
  await picker.getByRole('button', { name: 'library-fixtures' }).click()
  await expect(picker.getByRole('button', { name: 'nested' })).toBeVisible()
  await picker.getByRole('button', { name: 'nested' }).click()
  await expect(picker.getByRole('button', { name: 'deeper' })).toBeVisible()
  await picker.locator('button:has(svg.lucide-chevron-up)').click()
  await expect(picker.getByRole('button', { name: 'nested' })).toBeVisible()
  await picker.getByRole('button', { name: 'Cancel' }).click()
  await expect(picker).toHaveCount(0)

  await openFixtureRepo(page, 'recent-fixtures')
  await page.reload()
  await expect(page).toHaveURL(/\/canvas$/)
  await expect(page.getByRole('heading', { name: 'Canvas' })).toBeVisible()

  await page.goto('/')
  const recent = page.getByRole('button').filter({ hasText: 'recent-fixtures' })
  await expect(recent).toBeVisible()
  await expect(recent.getByText('1 image', { exact: true })).toBeVisible()
  await recent.click()
  await expect(page).toHaveURL(/\/canvas$/)
})

test('direct openRepo bootstraps a canvas and naked canvas route redirects', async ({
  page,
  browser,
}) => {
  const directPath = await fixturePath('direct-fixtures')
  await page.goto(`/?openRepo=${encodeURIComponent(directPath)}`)
  await expect(page).toHaveURL(/\/canvas$/)
  await expect(page.getByRole('heading', { name: 'Canvas' })).toBeVisible()
  await page.getByTestId('toggle-assets-shelf').click()
  await expect(
    page.getByRole('option', { name: 'direct-alpha.png' })
  ).toBeVisible()

  const context = await browser.newContext()
  const freshPage = await context.newPage()
  // A context created by hand has no configured base URL; the fresh session
  // still needs to hit this worker's server.
  await freshPage.goto(new URL('/canvas', page.url()).href)
  await expect(freshPage).toHaveURL('/')
  await expect(
    freshPage.getByRole('button', {
      name: /^(Create New Repo|New Repo)$/,
    })
  ).toBeVisible()
  await context.close()
})

test('server serves fixture thumbnails, previews, and original images', async ({
  page,
  request,
}) => {
  const thumbnailResponse = page.waitForResponse((response) =>
    response.url().includes('/loom-asset/thumb/')
  )
  await openFixtureRepo(page, 'direct-fixtures', { drawers: 'assets' })
  const thumbnail = await thumbnailResponse
  expect(thumbnail.status()).toBe(200)
  expect(thumbnail.headers()['content-type']).toContain('image/webp')
  expect((await thumbnail.body()).length).toBeGreaterThan(0)

  const previewURL = new URL(thumbnail.url().replace('/thumb/', '/preview/'))
  previewURL.searchParams.set('w', '640')
  const preview = await request.get(previewURL.href)
  expect(preview.status()).toBe(200)
  expect(preview.headers()['content-type']).toContain('image/webp')
  expect((await preview.body()).length).toBeGreaterThan(0)

  const fullURL = thumbnail.url().replace('/thumb/', '/full/')
  const full = await request.get(fullURL)
  expect(full.status()).toBe(200)
  expect(full.headers()['content-type']).toContain('image/png')
  expect(await full.body()).toEqual(
    await readFile(await fixturePath('direct-fixtures', 'direct-alpha.png'))
  )
})

test('server repo switcher opens another recent repo in a new tab', async ({
  page,
  context,
}) => {
  await openFixtureRepo(page, 'switch-b-fixtures')
  await page.goto('/')
  await openFixtureRepo(page, 'switch-a-fixtures')

  await page.getByRole('combobox', { name: 'Switch repository' }).click()
  await expect(
    page.getByRole('option', { name: 'switch-b-fixtures' })
  ).not.toContainText('Open')

  const newPagePromise = context.waitForEvent('page')
  await page.getByRole('option', { name: 'switch-b-fixtures' }).click()
  const newPage = await newPagePromise
  await newPage.waitForLoadState('domcontentloaded')

  await expect(page).toHaveURL(/\/canvas$/)
  await expect(
    page.getByRole('combobox', { name: 'Switch repository' })
  ).toContainText('switch-a-fixtures')
  await expect(newPage).toHaveURL(/\/canvas$/)
  await expect(
    newPage.getByRole('combobox', { name: 'Switch repository' })
  ).toContainText('switch-b-fixtures')

  const sameRepoPage = await context.newPage()
  const repoAPath = await fixturePath('switch-a-fixtures')
  await sameRepoPage.goto(`/?openRepo=${encodeURIComponent(repoAPath)}`)
  await expect(sameRepoPage).toHaveURL(/\/canvas$/)

  await newPage.getByRole('combobox', { name: 'Switch repository' }).click()
  await expect(
    newPage.getByRole('option', { name: 'switch-a-fixtures' })
  ).not.toContainText('Open')
  await sameRepoPage.close()
  await newPage.close()
})

test('drawers overlay the full Canvas and switch sides on compact viewports', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await openFixtureRepo(page, 'responsive-fixtures', { drawers: 'closed' })

  const canvas = page.getByRole('main', { name: 'Canvas' })
  await expect(
    page.getByRole('button', { name: 'Assets', exact: true })
  ).toHaveAttribute('aria-expanded', 'false')
  await expect(
    page.getByRole('button', { name: 'Inspector', exact: true })
  ).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(async () => (await canvas.boundingBox())?.width).toBe(390)

  await page.getByRole('button', { name: 'Assets', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Assets', exact: true })
  ).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(async () => (await canvas.boundingBox())?.width).toBe(390)

  await page.getByRole('button', { name: 'Inspector', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Assets', exact: true })
  ).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('aside[aria-label="Assets"]')).toHaveAttribute(
    'data-state',
    'closed'
  )
  await expect(page.locator('aside[aria-label="Inspector"]')).toHaveAttribute(
    'data-state',
    'open'
  )
  await expect(
    page.getByRole('heading', { name: 'No Selection', exact: true })
  ).toBeVisible()

  await page.setViewportSize({ width: 1400, height: 700 })
  await expect(
    page.getByRole('button', { name: 'Assets', exact: true })
  ).toHaveAttribute('aria-expanded', 'false')
  await expect(
    page.getByRole('button', { name: 'Inspector', exact: true })
  ).toHaveAttribute('aria-expanded', 'true')
})
