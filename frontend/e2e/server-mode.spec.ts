import { expect, test } from '@playwright/test'
import { fixturePath, openFixtureRepo } from './test-helpers'

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
  await expect(page).toHaveURL(/\/board$/)
  await expect(page.getByRole('heading', { name: 'Canvas' })).toBeVisible()

  await page.goto('/')
  const recent = page.getByRole('button').filter({ hasText: 'recent-fixtures' })
  await expect(recent).toBeVisible()
  await expect(recent).toContainText('1 images')
  await recent.click()
  await expect(page).toHaveURL(/\/board$/)
})

test('direct openRepo bootstraps a board and naked board route redirects', async ({
  page,
  browser,
}) => {
  const directPath = await fixturePath('direct-fixtures')
  await page.goto(`/?openRepo=${encodeURIComponent(directPath)}`)
  await expect(page).toHaveURL(/\/board$/)
  await expect(page.getByRole('heading', { name: 'Canvas' })).toBeVisible()
  await expect(
    page.getByRole('option', { name: 'direct-alpha.png' })
  ).toBeVisible()

  const context = await browser.newContext()
  const freshPage = await context.newPage()
  await freshPage.goto('/board')
  await expect(freshPage).toHaveURL('/')
  await expect(
    freshPage.getByRole('button', {
      name: /^(Create New Repo|New Repo)$/,
    })
  ).toBeVisible()
  await context.close()
})

test('server repo switcher opens another recent repo in a new tab', async ({
  page,
  context,
}) => {
  await openFixtureRepo(page, 'switch-b-fixtures')
  await page.goto('/')
  await openFixtureRepo(page, 'switch-a-fixtures')

  await page.getByRole('combobox', { name: 'Switch repository' }).click()

  const newPagePromise = context.waitForEvent('page')
  await page.getByRole('option', { name: 'switch-b-fixtures' }).click()
  const newPage = await newPagePromise
  await newPage.waitForLoadState('domcontentloaded')

  await expect(page).toHaveURL(/\/board$/)
  await expect(
    page.getByRole('combobox', { name: 'Switch repository' })
  ).toContainText('switch-a-fixtures')
  await expect(newPage).toHaveURL(/\/board$/)
  await expect(
    newPage.getByRole('combobox', { name: 'Switch repository' })
  ).toContainText('switch-b-fixtures')
  await newPage.close()
})

test('side panels collapse into overlays on compact viewports', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 700 })
  await openFixtureRepo(page, 'responsive-fixtures')

  const canvas = page.getByRole('main', { name: 'Canvas' })
  await expect(
    page.getByRole('button', { name: 'A', exact: true })
  ).toHaveAttribute('aria-expanded', 'false')
  await expect(
    page.getByRole('button', { name: 'I', exact: true })
  ).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(async () => (await canvas.boundingBox())?.width).toBe(1024)

  await page.getByRole('button', { name: 'A', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Assets', exact: true })
  ).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(async () => (await canvas.boundingBox())?.width).toBe(1024)

  await page.getByRole('button', { name: 'I', exact: true }).click()
  await expect(
    page.getByText('Select an asset, set, or relationship.')
  ).toBeVisible()
})
