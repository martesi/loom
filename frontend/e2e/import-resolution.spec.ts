import { execFile } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { runtimeMethodID } from './bindings'
import { legacyServiceCall } from './legacy-service'
import { expect, test } from './test-fixtures'
import { fixturePath, openAssetsShelf, openFixtureRepo } from './test-helpers'

const execFileAsync = promisify(execFile)
const repositoryRoot = path.resolve(import.meta.dirname, '../..')

async function seedFixture(repoPath: string, mode: string) {
  await execFileAsync(
    'go',
    [
      'test',
      './internal/service',
      '-run',
      '^TestSeedImportRecoveryE2EFixture$',
      '-count=1',
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        LOOM_E2E_IMPORT_FIXTURE_ROOT: repoPath,
        LOOM_E2E_IMPORT_FIXTURE_MODE: mode,
      },
      timeout: 30_000,
      maxBuffer: 1 << 20,
    }
  )
}

test('Assets can partially recover and explicitly release changed pending files', async ({
  page,
}) => {
  const repoPath = await fixturePath('clipboard-fixtures')
  await seedFixture(repoPath, 'pending')
  await openFixtureRepo(page, 'clipboard-fixtures', { drawers: 'assets' })
  const trigger = page.getByTestId('import-recovery-trigger')
  await expect(trigger).toBeVisible()
  await trigger.click()
  const dialog = page.getByTestId('import-recovery-dialog')
  await expect(dialog).toBeVisible()

  const verified = dialog
    .getByTestId('pending-import-file')
    .filter({ hasText: 'e2e-pending-verified.png' })
  const changed = dialog
    .getByTestId('pending-import-file')
    .filter({ hasText: 'e2e-pending-changed.png' })
  const missing = dialog
    .getByTestId('pending-import-file')
    .filter({ hasText: 'e2e-pending-missing.png' })
  await expect(verified).toHaveAttribute('data-recovery-status', 'verified')
  await expect(changed).toHaveAttribute('data-recovery-status', 'changed')
  await expect(missing).toHaveAttribute('data-recovery-status', 'missing')
  await verified.getByTestId('select-pending-import').check()
  await changed.getByTestId('select-pending-release').check()
  await dialog.getByTestId('resolve-pending-import').click()
  const releaseWarning = dialog.getByTestId('release-reservation-confirmation')
  await expect(releaseWarning).toBeVisible()
  await expect(
    releaseWarning.getByTestId('confirm-reservation-release')
  ).toBeVisible()
  await dialog.getByTestId('confirm-reservation-release').click()

  const activeRow = page
    .locator('[data-asset-id]')
    .filter({ hasText: 'e2e-pending-verified.png' })
  await expect(activeRow).toBeVisible()
  const verifiedPath = await fixturePath(
    'clipboard-fixtures',
    'e2e-pending-verified.png'
  )
  const changedPath = await fixturePath(
    'clipboard-fixtures',
    'e2e-pending-changed.png'
  )
  const missingPath = await fixturePath(
    'clipboard-fixtures',
    'e2e-pending-missing.png'
  )
  await access(verifiedPath)
  expect(await readFile(changedPath, 'utf8')).toBe('changed by user')
  await expect
    .poll(() =>
      access(missingPath).then(
        () => true,
        () => false
      )
    )
    .toBe(false)

  await trigger.click()
  const reopened = page.getByTestId('import-recovery-dialog')
  await expect(reopened).toBeVisible()
  const remaining = reopened.getByTestId('pending-import-file')
  await expect(remaining).toHaveCount(1)
  await expect(remaining).toHaveAttribute('data-recovery-status', 'missing')
  await expect(remaining).toContainText('e2e-pending-missing.png')
})

test('Canvas loads and recovery remains visible with expired trash linked to a retained import', async ({
  page,
}) => {
  const repoPath = await fixturePath('clipboard-fixtures')
  await seedFixture(repoPath, 'expired-retained-link')
  await openFixtureRepo(page, 'clipboard-fixtures', { drawers: 'assets' })
  await expect(page.locator('.react-flow')).toBeVisible()
  await expect(page.getByTestId('import-recovery-panel')).toBeVisible()

  const listMethodID = runtimeMethodID(
    'imageservice.ts',
    'ListRecoverableImports'
  )
  const response = page.waitForResponse(
    (item) =>
      item.url().endsWith('/wails/runtime') &&
      item.request().postData()?.includes(`"methodID":${listMethodID}`) === true
  )
  await page.getByTestId('import-recovery-trigger').click()
  expect((await response).ok()).toBe(true)
  const dialog = page.getByTestId('import-recovery-dialog')
  await expect(dialog).toBeVisible()
  const retained = dialog.getByTestId('retained-import')
  await expect(retained).toHaveAttribute('data-recovery-status', 'verified')
  await expect(retained).toContainText('e2e-retained-target.png')
  await access(
    await fixturePath('clipboard-fixtures', 'e2e-expired-source.png')
  )
  await access(
    await fixturePath('clipboard-fixtures', 'e2e-retained-target.png')
  )
  await expect(page.getByText(/cannot purge image/i)).toHaveCount(0)
})

test('legacy retained identity needs two confirmations and has guarded undo/redo', async ({
  page,
}) => {
  const repoPath = await fixturePath('clipboard-fixtures')
  await seedFixture(repoPath, 'legacy-retained')
  await openFixtureRepo(page, 'clipboard-fixtures', { drawers: 'assets' })
  const trigger = page.getByTestId('import-recovery-trigger')
  await trigger.click()
  const dialog = page.getByTestId('import-recovery-dialog')
  const retained = dialog.getByTestId('retained-import')
  await expect(retained).toHaveAttribute('data-recovery-status', 'untrusted')
  const identity = await retained.getAttribute('data-image-id')
  expect(identity).toBeTruthy()
  const show = retained.getByTestId('show-unverified-retained')
  await expect(show).toBeEnabled()
  await show.click()
  await expect(dialog.getByTestId('show-unverified-confirmation')).toBeVisible()
  await dialog.getByTestId('cancel-show-unverified').click()
  await expect(retained).toHaveAttribute('data-recovery-status', 'untrusted')
  await expect(
    page
      .locator('[data-asset-id]')
      .filter({ hasText: 'e2e-legacy-retained.png' })
  ).toHaveCount(0)

  await retained.getByTestId('show-unverified-retained').click()
  await expect(dialog.getByTestId('show-unverified-confirmation')).toBeVisible()
  const filePath = await fixturePath(
    'clipboard-fixtures',
    'e2e-legacy-retained.png'
  )
  const reviewedFingerprint = await retained.getAttribute(
    'data-current-fingerprint'
  )
  await writeFile(filePath, 'changed after the evidence review')
  await dialog.getByTestId('confirm-show-unverified').click()
  await expect(dialog.getByTestId('show-unverified-confirmation')).toBeVisible()
  await expect(retained).not.toHaveAttribute(
    'data-current-fingerprint',
    reviewedFingerprint ?? ''
  )
  await expect(
    page
      .locator('[data-asset-id]')
      .filter({ hasText: 'e2e-legacy-retained.png' })
  ).toHaveCount(0)
  // The stale confirmation only refreshes the request. A second explicit click
  // is required before the separate redo-history confirmation appears.
  await dialog.getByTestId('confirm-show-unverified').click()
  await expect(
    dialog.getByTestId('redo-replacement-confirmation')
  ).toBeVisible()
  await dialog.getByTestId('confirm-redo-replacement').click()
  const activeRow = page
    .locator('[data-asset-id]')
    .filter({ hasText: 'e2e-legacy-retained.png' })
  await expect(activeRow).toBeVisible()
  await expect(activeRow).toHaveAttribute('data-asset-id', identity ?? '')
  await access(filePath)

  await page.keyboard.press('ControlOrMeta+z')
  await expect(activeRow).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(activeRow).toBeVisible()
  await expect(activeRow).toHaveAttribute('data-asset-id', identity ?? '')
  await access(filePath)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(activeRow).toHaveCount(0)

  await page.reload()
  await expect(page.locator('.react-flow')).toBeVisible()
  await openAssetsShelf(page)
  await page.getByTestId('import-recovery-trigger').click()
  const afterReload = page.getByTestId('import-recovery-dialog')
  await expect(afterReload.getByTestId('retained-import')).toHaveAttribute(
    'data-recovery-status',
    'untrusted'
  )
  await access(filePath)
})

test('replacement discovery preserves import undo and redo history', async ({
  page,
}) => {
  const repoPath = await fixturePath('clipboard-fixtures')
  await openFixtureRepo(page, 'clipboard-fixtures', { drawers: 'assets' })
  const [imageID] = await legacyServiceCall<number[]>(
    page,
    'imageservice.ts',
    'ImportMedia',
    [
      repoPath,
      [
        {
          name: 'e2e-original.png',
          data: Buffer.from('original').toString('base64'),
        },
      ],
      true,
      31,
      47,
    ]
  )
  expect(imageID).toBeGreaterThan(0)
  await legacyServiceCall<void>(page, 'imageservice.ts', 'ReplaceMedia', [
    repoPath,
    imageID,
    {
      name: 'e2e-replacement.png',
      data: Buffer.from('replacement').toString('base64'),
    },
  ])
  await legacyServiceCall(page, 'imageservice.ts', 'LoadCanvas', [repoPath])
  await page.reload()
  await openAssetsShelf(page)
  const original = page
    .locator('[data-asset-id]')
    .filter({ hasText: 'e2e-original.png' })
  const replacement = page
    .locator('[data-asset-id]')
    .filter({ hasText: 'e2e-replacement.png' })
  await expect(replacement).toHaveAttribute('data-asset-id', String(imageID))
  const originalPath = await fixturePath(
    'clipboard-fixtures',
    'e2e-original.png'
  )
  const replacementPath = await fixturePath(
    'clipboard-fixtures',
    'e2e-replacement.png'
  )

  const undoReplacement = await legacyServiceCall<{
    applied: boolean
    error?: string
  }>(page, 'undoservice.ts', 'Undo', [repoPath])
  expect(undoReplacement?.applied, JSON.stringify(undoReplacement)).toBe(true)
  await page.reload()
  await openAssetsShelf(page)
  await expect(original).toHaveAttribute('data-asset-id', String(imageID))
  expect(await readFile(originalPath, 'utf8')).toBe('original')

  const undoImport = await legacyServiceCall<{
    applied: boolean
    error?: string
  }>(page, 'undoservice.ts', 'Undo', [repoPath])
  expect(undoImport?.applied, JSON.stringify(undoImport)).toBe(true)
  await page.reload()
  await openAssetsShelf(page)
  await expect(original).toHaveCount(0)
  await access(originalPath)

  const redoImport = await legacyServiceCall<{
    applied: boolean
    error?: string
  }>(page, 'undoservice.ts', 'Redo', [repoPath])
  expect(redoImport?.applied, JSON.stringify(redoImport)).toBe(true)
  await page.reload()
  await openAssetsShelf(page)
  await expect(original).toHaveAttribute('data-asset-id', String(imageID))
  expect(await readFile(originalPath, 'utf8')).toBe('original')

  const redoReplacement = await legacyServiceCall<{
    applied: boolean
    error?: string
  }>(page, 'undoservice.ts', 'Redo', [repoPath])
  expect(redoReplacement?.applied, JSON.stringify(redoReplacement)).toBe(true)
  await page.reload()
  await openAssetsShelf(page)
  await expect(replacement).toHaveAttribute('data-asset-id', String(imageID))
  expect(await readFile(replacementPath, 'utf8')).toBe('replacement')
})
