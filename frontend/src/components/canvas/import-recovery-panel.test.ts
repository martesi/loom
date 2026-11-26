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
import { ImageService } from '../../../bindings/loom/internal/service'

function Trans({ children }: { children: ReactNode }) {
  return children
}

mock.module('@lingui/react/macro', () => ({ Trans }))
const { ImportRecoveryPanel } = await import('./import-recovery-panel')

afterEach(() => {
  cleanup()
  mock.restore()
})

it('keeps incomplete and ambiguous pending files visible without recovering them', async () => {
  spyOn(ImageService, 'ListPendingImportBatches').mockResolvedValue([
    {
      id: 'pending-1',
      files: [
        {
          path: '/repo/verified.png',
          fingerprint: 'expected-a',
          filePresent: true,
          verified: true,
        },
        {
          path: '/repo/changed.png',
          fingerprint: 'expected-b',
          filePresent: true,
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
      filePresent: false,
      verified: false,
    },
  ] as never)
  const recoverBatch = spyOn(ImageService, 'RecoverPendingImportBatch')
  const recoverLegacy = spyOn(ImageService, 'RecoverImport')
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
  expect(
    screen.getByText(/file differs from the recorded import/i)
  ).toBeTruthy()
  expect(
    screen.getByText(/legacy record has no trusted fingerprint/i)
  ).toBeTruthy()
  expect(
    screen.getByRole('button', { name: /finish verified batch/i })
  ).toHaveProperty('disabled', true)
  expect(
    screen.getByRole('button', { name: /restore verified import/i })
  ).toHaveProperty('disabled', true)
  expect(recoverBatch).not.toHaveBeenCalled()
  expect(recoverLegacy).not.toHaveBeenCalled()
})

it('requires explicit confirmation before replacing redo history', async () => {
  spyOn(ImageService, 'ListPendingImportBatches').mockResolvedValue([] as never)
  spyOn(ImageService, 'ListRecoverableImports').mockResolvedValue([
    {
      imageId: 7,
      filePath: '/repo/kept.png',
      fingerprint: 'verified-digest',
      trusted: true,
      filePresent: true,
      verified: true,
    },
  ] as never)
  const recover = spyOn(ImageService, 'RecoverImport').mockRejectedValue(
    new Error('cannot recover import while redo history exists')
  )
  const replace = spyOn(
    ImageService,
    'RecoverImportAndReplaceRedo'
  ).mockResolvedValue(undefined as never)
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
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Replacing it is permanent'
  )
  expect(recover).toHaveBeenCalledTimes(1)
  expect(replace).not.toHaveBeenCalled()
  fireEvent.click(
    screen.getByRole('button', { name: /replace redo history and recover/i })
  )
  await waitFor(() => expect(replace).toHaveBeenCalledWith('/repo', 7))
  await waitFor(() => expect(onRecovered).toHaveBeenCalledTimes(1))
})
