import { afterEach, expect, it, mock } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createElement, createRef } from 'react'
import type { RepoInfo } from '../../../bindings/loom/internal/service'

function MockTrans({ children }: { children: ReactNode }) {
  return createElement('span', null, children)
}

function MockRepoSelect() {
  return null
}

mock.module('@lingui/core/macro', () => ({
  t: (parts: TemplateStringsArray) => parts.join(''),
}))
mock.module('@lingui/react/macro', () => ({
  Trans: MockTrans,
}))
mock.module('./repo-select', () => ({
  RepoSelect: MockRepoSelect,
}))
const { CanvasToolbar } = await import('./canvas-toolbar')

afterEach(() => {
  cleanup()
  mock.restore()
})

it('cancels a pending picker intent without importing empty files', () => {
  const importInput = createRef<HTMLInputElement>()
  const onOpenImport = mock()
  const onImportFiles = mock()
  const onImportCancel = mock()
  render(
    createElement(CanvasToolbar, {
      repo: { path: '/isolated', name: 'isolated' } as RepoInfo,
      repoOpenRequest: 0,
      focusCanvas: false,
      assetsOpen: false,
      inspectorOpen: false,
      repoMenuOpen: false,
      setRepoMenuOpen: mock(),
      repoMenuRef: createRef(),
      importInput,
      onOpenImport,
      actionShortcut: () => undefined,
      openPalette: mock(),
      executeActionById: mock(),
      toggleFocusMode: mock(),
      onImportFiles,
      onImportCancel,
    })
  )

  onOpenImport()
  expect(onOpenImport).toHaveBeenCalledTimes(1)

  importInput.current?.dispatchEvent(new Event('cancel'))
  expect(onImportCancel).toHaveBeenCalledTimes(1)
  expect(onImportFiles).not.toHaveBeenCalled()
})
