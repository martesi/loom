import { afterEach, expect, it, mock, spyOn } from 'bun:test'
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

afterEach(() => {
  cleanup()
  mock.restore()
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
