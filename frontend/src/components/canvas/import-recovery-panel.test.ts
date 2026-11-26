import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import {
  ImageService,
  ImportResolutionStatus,
} from '../../../bindings/loom/internal/service'

function Trans({ children }: { children: ReactNode }) {
  return children
}

mock.module('@lingui/react/macro', () => ({ Trans }))
const { ImportRecoveryPanel } = await import('./import-recovery-panel')
let legacyTailMock: { resolveOnce: (result: unknown) => void }

afterEach(() => {
  cleanup()
  mock.restore()
})

beforeEach(() => {
  spyOn(
    ImageService,
    'ListPendingFilesystemHistoryRecoveries'
  ).mockResolvedValue([] as never)
  spyOn(ImageService, 'ListPendingReplacementRecoveries').mockResolvedValue(
    [] as never
  )
  const tailSpy = spyOn(
    ImageService,
    'GetUnverifiedReplacementRedoTail'
  ).mockResolvedValue({
    available: false,
    cursor: 0,
  } as never)
  legacyTailMock = {
    resolveOnce: (result) => tailSpy.mockResolvedValueOnce(result as never),
  }
})

it('resolves only selected verified items and confirms safe reservation release', async () => {
  spyOn(ImageService, 'ListPendingImportBatches').mockResolvedValue([
    {
      id: 'pending-1',
      files: [
        {
          itemIndex: 0,
          path: '/repo/verified.png',
          fingerprint: 'expected-a',
          status: ImportResolutionStatus.ImportStatusVerified,
          recordedFingerprint: 'expected-a',
          currentFingerprint: 'expected-a',
          filePresent: true,
          verified: true,
        },
        {
          itemIndex: 1,
          path: '/repo/changed.png',
          fingerprint: 'expected-b',
          status: ImportResolutionStatus.ImportStatusChanged,
          recordedFingerprint: 'expected-b',
          currentFingerprint: 'current-b',
          filePresent: true,
          verified: false,
        },
        {
          itemIndex: 2,
          path: '/repo/missing.png',
          fingerprint: 'expected-c',
          status: ImportResolutionStatus.ImportStatusMissing,
          recordedFingerprint: 'expected-c',
          filePresent: false,
          verified: false,
        },
      ],
    },
  ] as never)
  spyOn(ImageService, 'ListRecoverableImports').mockResolvedValue([
    {
      imageId: 9,
      filePath: '/repo/legacy.png',
      fingerprint: '',
      trusted: false,
      status: ImportResolutionStatus.ImportStatusUntrusted,
      recordedFingerprint: '',
      filePresent: false,
      verified: false,
    },
  ] as never)
  const resolve = spyOn(
    ImageService,
    'ResolvePendingImportBatch'
  ).mockResolvedValue({
    imageIds: [12],
    releasedItemIndexes: [1],
    needsRedoConfirmation: false,
    idempotentReplay: false,
  } as never)
  const onRecovered = mock(async () => {})
  render(
    createElement(ImportRecoveryPanel, {
      path: '/repo',
      refresh: 0,
      onRecovered,
    })
  )
  await act(async () => Promise.resolve())
  fireEvent.click(screen.getByRole('button', { name: /import recovery/i }))
  expect(await screen.findByText('/repo/changed.png')).toBeTruthy()
  expect(screen.getByText('/repo/missing.png')).toBeTruthy()
  expect(screen.getByText(/changed; current file differs/i)).toBeTruthy()
  expect(screen.getByText(/missing; reservation remains/i)).toBeTruthy()
  expect(screen.getByText(/untrusted legacy evidence/i)).toBeTruthy()
  expect(
    screen
      .getAllByTestId('pending-import-file')[0]
      .getAttribute('data-recovery-status')
  ).toBe(ImportResolutionStatus.ImportStatusVerified)
  const resolveButton = screen.getByTestId('resolve-pending-import')
  expect(resolveButton).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByLabelText(/import this verified file/i))
  fireEvent.click(screen.getAllByLabelText(/release this safe reservation/i)[0])
  fireEvent.click(resolveButton)
  expect(
    await screen.findByTestId('release-reservation-confirmation')
  ).toBeTruthy()
  expect(resolve).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('confirm-reservation-release'))
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))
  expect(resolve).toHaveBeenCalledWith('/repo', {
    batchId: 'pending-1',
    requestId: expect.any(String),
    selectedItemIndexes: [0],
    releasedItemIndexes: [1],
    confirmReservationRelease: true,
  })
  expect(onRecovered).toHaveBeenCalledTimes(1)
})

it('shows filesystem-history recovery independently and retries a verified layout', async () => {
  spyOn(ImageService, 'ListPendingImportBatches').mockResolvedValue([] as never)
  spyOn(ImageService, 'ListRecoverableImports').mockResolvedValue([] as never)
  spyOn(
    ImageService,
    'ListPendingFilesystemHistoryRecoveries'
  ).mockResolvedValue([
    {
      requestId: 'fs-request',
      direction: 'undo',
      kind: 'move_file',
      sequence: 4,
      imageId: 22,
      sourcePath: '/repo/moved.png',
      destinationPath: '/repo/source.png',
      state: 'source-present-destination-absent',
      canRetry: true,
      canCancel: true,
      legacyWithoutLedger: false,
      message: 'Source and bytes verified.',
    },
  ] as never)
  const retry = spyOn(
    ImageService,
    'RetryFilesystemHistoryRecovery'
  ).mockResolvedValue({ applied: true, pendingRecovery: false } as never)
  const onRecovered = mock(async () => {})
  render(
    createElement(ImportRecoveryPanel, {
      path: '/repo',
      refresh: 0,
      onRecovered,
    })
  )
  await act(async () => Promise.resolve())
  fireEvent.click(screen.getByTestId('import-recovery-trigger'))
  expect(
    await screen.findByTestId('pending-filesystem-history-recovery')
  ).toBeTruthy()
  expect(screen.getByText('/repo/source.png')).toBeTruthy()
  fireEvent.click(
    screen.getByRole('button', { name: /retry verified history move/i })
  )
  await waitFor(() => expect(retry).toHaveBeenCalledWith('/repo', 'fs-request'))
  expect(onRecovered).toHaveBeenCalledTimes(1)
})

it('binds retained recovery confirmation to the exact redo-tail token', async () => {
  spyOn(ImageService, 'ListPendingImportBatches').mockResolvedValue([] as never)
  spyOn(ImageService, 'ListRecoverableImports').mockResolvedValue([
    {
      imageId: 7,
      filePath: '/repo/kept.png',
      fingerprint: 'verified-digest',
      trusted: true,
      status: ImportResolutionStatus.ImportStatusVerified,
      recordedFingerprint: 'verified-digest',
      currentFingerprint: 'verified-digest',
      filePresent: true,
      verified: true,
    },
  ] as never)
  const recover = spyOn(ImageService, 'ResolveRetainedImport')
    .mockResolvedValueOnce({
      applied: false,
      status: ImportResolutionStatus.ImportStatusVerified,
      needsRedoConfirmation: true,
      redoTailConfirmation: 'branch-token',
      idempotentReplay: false,
    } as never)
    .mockResolvedValueOnce({
      applied: true,
      status: ImportResolutionStatus.ImportStatusVerified,
      needsRedoConfirmation: false,
      idempotentReplay: false,
    } as never)
  const onRecovered = mock(async () => {})
  render(
    createElement(ImportRecoveryPanel, {
      path: '/repo',
      refresh: 0,
      onRecovered,
    })
  )
  await act(async () => Promise.resolve())
  fireEvent.click(screen.getByRole('button', { name: /import recovery/i }))
  fireEvent.click(
    await screen.findByRole('button', { name: /restore verified import/i })
  )
  expect(
    await screen.findByTestId('redo-replacement-confirmation')
  ).toBeTruthy()
  expect(recover).toHaveBeenCalledTimes(1)
  const firstRequest = recover.mock.calls[0]?.[1]
  fireEvent.click(screen.getByTestId('confirm-redo-replacement'))
  await waitFor(() => expect(recover).toHaveBeenCalledTimes(2))
  expect(recover.mock.calls[1]?.[1]).toEqual({
    ...firstRequest,
    redoTailConfirmation: 'branch-token',
  })
  await waitFor(() => expect(onRecovered).toHaveBeenCalledTimes(1))
})

it('requires separate evidence and redo confirmations to show an untrusted identity', async () => {
  spyOn(ImageService, 'ListPendingImportBatches').mockResolvedValue([] as never)
  spyOn(ImageService, 'ListRecoverableImports').mockResolvedValue([
    {
      imageId: 31,
      filePath: '/repo/legacy.png',
      fingerprint: '',
      recordedFingerprint: '',
      currentFingerprint: 'observed-current-digest',
      trusted: false,
      status: ImportResolutionStatus.ImportStatusUntrusted,
      filePresent: true,
      verified: false,
    },
  ] as never)
  const resolve = spyOn(ImageService, 'ResolveRetainedImport')
    .mockResolvedValueOnce({
      applied: false,
      status: ImportResolutionStatus.ImportStatusUntrusted,
      currentFingerprint: 'observed-current-digest',
      needsUnverifiedConfirmation: true,
      evidenceConfirmation: 'evidence-token',
      needsRedoConfirmation: false,
      idempotentReplay: false,
    } as never)
    .mockResolvedValueOnce({
      applied: false,
      status: ImportResolutionStatus.ImportStatusUntrusted,
      currentFingerprint: 'observed-current-digest',
      needsUnverifiedConfirmation: false,
      needsRedoConfirmation: true,
      redoTailConfirmation: 'branch-token',
      idempotentReplay: false,
    } as never)
    .mockResolvedValueOnce({
      applied: true,
      status: ImportResolutionStatus.ImportStatusUntrusted,
      currentFingerprint: 'observed-current-digest',
      needsUnverifiedConfirmation: false,
      needsRedoConfirmation: false,
      idempotentReplay: false,
    } as never)
  const onRecovered = mock(async () => {})
  render(
    createElement(ImportRecoveryPanel, {
      path: '/repo',
      refresh: 0,
      onRecovered,
    })
  )
  await act(async () => Promise.resolve())
  fireEvent.click(screen.getByRole('button', { name: /import recovery/i }))
  fireEvent.click(await screen.findByTestId('show-unverified-retained'))
  expect(await screen.findByTestId('show-unverified-confirmation')).toBeTruthy()
  const initial = resolve.mock.calls[0]?.[1]
  fireEvent.click(screen.getByTestId('confirm-show-unverified'))
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
  expect(resolve.mock.calls[1]?.[1]).toEqual({
    ...initial,
    confirmUnverified: true,
    evidenceConfirmation: 'evidence-token',
  })
  fireEvent.click(screen.getByTestId('confirm-redo-replacement'))
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(3))
  expect(resolve.mock.calls[2]?.[1]).toEqual({
    ...initial,
    confirmUnverified: true,
    evidenceConfirmation: 'evidence-token',
    redoTailConfirmation: 'branch-token',
  })
  await waitFor(() => expect(onRecovered).toHaveBeenCalledTimes(1))
})

it('loads replacement evidence independently when other recovery lists fail', async () => {
  spyOn(ImageService, 'ListPendingImportBatches').mockResolvedValue([
    {
      id: 'independent-batch',
      files: [
        {
          itemIndex: 0,
          path: '/repo/kept-file.png',
          fingerprint: 'verified',
          status: ImportResolutionStatus.ImportStatusVerified,
          recordedFingerprint: 'verified',
          currentFingerprint: 'verified',
          filePresent: true,
          verified: true,
        },
      ],
    },
  ] as never)
  spyOn(ImageService, 'ListRecoverableImports').mockRejectedValue(
    new Error('retained list unavailable')
  )
  spyOn(ImageService, 'ListPendingReplacementRecoveries').mockRejectedValue(
    new Error('replacement list unavailable')
  )
  render(
    createElement(ImportRecoveryPanel, {
      path: '/repo',
      refresh: 0,
      onRecovered: mock(async () => {}),
      className: 'workspace-recovery-entry',
    })
  )
  const entry = screen.getByTestId('import-recovery-panel')
  expect(entry.className).toContain('workspace-recovery-entry')
  fireEvent.click(
    await screen.findByRole('button', {
      name: /recovery status needs review/i,
    })
  )
  expect(await screen.findByText('/repo/kept-file.png')).toBeTruthy()
  expect(await screen.findByText('replacement list unavailable')).toBeTruthy()
  expect(screen.queryByText(/no interrupted imports/i)).toBeNull()
  expect(
    screen.getByRole('button', {
      name: /retry replacement status and recovery/i,
    })
  ).toBeTruthy()
})

it('offers an explicit full redo-tail discard without changing files', async () => {
  spyOn(ImageService, 'ListPendingImportBatches').mockResolvedValue([] as never)
  spyOn(ImageService, 'ListRecoverableImports').mockResolvedValue([] as never)
  spyOn(ImageService, 'ListPendingReplacementRecoveries').mockResolvedValue(
    [] as never
  )
  const availableTail = {
    available: true,
    status: 'unverified',
    cursor: 1,
    startSeq: 2,
    endSeq: 4,
    operationCount: 3,
    confirmation: 'exact-full-tail-token',
    warning:
      'Discard all 3 redo operations from 2 through 4. No files will be deleted.',
  }
  legacyTailMock.resolveOnce(availableTail)
  legacyTailMock.resolveOnce(availableTail)
  legacyTailMock.resolveOnce({ available: false, cursor: 1 })
  const resolve = spyOn(
    ImageService,
    'ResolveUnverifiedReplacementRedoTail'
  ).mockResolvedValue({
    applied: true,
    requestId: 'legacy-tail-request',
    cursor: 1,
    discardedCount: 3,
  } as never)
  const onRecovered = mock(async () => {})
  render(
    createElement(ImportRecoveryPanel, {
      path: '/repo',
      refresh: 0,
      onRecovered,
    })
  )
  fireEvent.click(
    await screen.findByRole('button', { name: /import recovery \(1\)/i })
  )
  expect(await screen.findByTestId('unverified-legacy-redo-tail')).toBeTruthy()
  expect(screen.getByText(/all 3 redo operations/i)).toBeTruthy()
  fireEvent.click(screen.getByTestId('discard-unverified-redo-tail'))
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))
  expect(resolve).toHaveBeenCalledWith(
    '/repo',
    expect.any(String),
    'exact-full-tail-token'
  )
  expect(onRecovered).toHaveBeenCalledTimes(1)
})

it('requires fresh explicit consent after stale evidence and keeps uncertain retries idempotent', async () => {
  spyOn(ImageService, 'ListPendingImportBatches').mockResolvedValue([] as never)
  spyOn(ImageService, 'ListRecoverableImports').mockResolvedValue([
    {
      imageId: 45,
      filePath: '/repo/legacy.png',
      fingerprint: '',
      recordedFingerprint: '',
      currentFingerprint: 'observed-old',
      trusted: false,
      status: ImportResolutionStatus.ImportStatusUntrusted,
      filePresent: true,
      verified: false,
    },
  ] as never)
  const resolve = spyOn(ImageService, 'ResolveRetainedImport')
    .mockResolvedValueOnce({
      applied: false,
      status: ImportResolutionStatus.ImportStatusChanged,
      recordedFingerprint: 'recorded-original',
      currentFingerprint: 'backend-observed-after-list',
      needsUnverifiedConfirmation: true,
      evidenceConfirmation: 'token-initial-observation',
    } as never)
    .mockResolvedValueOnce({
      applied: false,
      status: ImportResolutionStatus.ImportStatusChanged,
      currentFingerprint: 'observed-new',
      resolutionError:
        'unverified evidence changed; review the current item state and confirm again',
      needsUnverifiedConfirmation: true,
      evidenceConfirmationStale: true,
      evidenceConfirmation: 'token-new',
    } as never)
    .mockRejectedValueOnce(new Error('transport disconnected'))
    .mockResolvedValueOnce({
      applied: true,
      status: ImportResolutionStatus.ImportStatusChanged,
    } as never)
  const onRecovered = mock(async () => {})
  render(
    createElement(ImportRecoveryPanel, {
      path: '/repo',
      refresh: 0,
      onRecovered,
    })
  )
  await act(async () => Promise.resolve())
  fireEvent.click(screen.getByRole('button', { name: /import recovery/i }))
  fireEvent.click(await screen.findByTestId('show-unverified-retained'))
  const confirmation = await screen.findByTestId('show-unverified-confirmation')
  expect(confirmation.getAttribute('data-evidence-confirmation')).toBe(
    'token-initial-observation'
  )
  expect(
    screen.getByTestId('show-unverified-observed-evidence').textContent
  ).toContain('backend-observed-after-list')
  expect(
    screen
      .getByTestId('retained-import')
      .getAttribute('data-current-fingerprint')
  ).toBe('backend-observed-after-list')
  fireEvent.click(await screen.findByTestId('confirm-show-unverified'))
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
  expect(
    screen.getByTestId('show-unverified-observed-evidence').textContent
  ).toContain('observed-new')
  expect(screen.getByTestId('show-unverified-confirmation')).toBeTruthy()
  expect(onRecovered).not.toHaveBeenCalled()
  const oldRequest = resolve.mock.calls[1]?.[1]
  fireEvent.click(screen.getByTestId('confirm-show-unverified'))
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(3))
  expect(resolve.mock.calls[2]?.[1]).toEqual({
    ...oldRequest,
    evidenceConfirmation: 'token-new',
  })
  // A transport error does not prove the request was rejected. The next
  // explicit attempt reuses its request ID and confirmation token.
  fireEvent.click(screen.getByTestId('confirm-show-unverified'))
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(4))
  expect(resolve.mock.calls[3]?.[1]).toEqual(resolve.mock.calls[2]?.[1])
  await waitFor(() => expect(onRecovered).toHaveBeenCalledTimes(1))
})
