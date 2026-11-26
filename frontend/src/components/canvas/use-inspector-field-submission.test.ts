import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import {
  ImageService,
  TagService,
} from '../../../bindings/loom/internal/service'
import { useCanvasSelectionAuthority } from './canvas-selection-intent'

mock.module('@lingui/core/macro', () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (result, part, index) => `${result}${part}${String(values[index] ?? '')}`,
      ''
    ),
}))
const { useInspectorFieldSubmission } = await import(
  './use-inspector-field-submission'
)

afterEach(() => {
  cleanup()
  mock.restore()
})

it('rejects inspector submission after same-batch A→B→A user selection', async () => {
  let resolveImage: (image: never) => void = () => {}
  spyOn(ImageService, 'GetImage').mockImplementation(
    () => new Promise((resolve) => (resolveImage = resolve))
  )
  const addTag = spyOn(TagService, 'AddTag').mockResolvedValue(
    undefined as never
  )
  const reload = mock(async () => {})
  const groupMembers = mock(() => [])
  const fieldSubmissionPending = { current: false }
  const hook = renderHook(
    () => {
      const authority = useCanvasSelectionAuthority('/inspector-selection', {
        surface: 'assets',
        ids: [1],
        edges: [],
        group: null,
      })
      const submit = useInspectorFieldSubmission({
        repoPath: '/inspector-selection',
        selectionRef: authority.selectionRef,
        groupMembers,
        reload,
        fieldSubmissionPending,
        submissionScopeRef: authority.intentRef,
      })
      return { authority, submit }
    },
    { wrapper: StrictMode }
  )
  let submit: Promise<void>
  act(() => {
    submit = hook.result.current.submit('add-tag', 'approved', [1])
    hook.result.current.authority.setSelection({
      surface: 'assets',
      ids: [2],
      edges: [],
      group: null,
    })
    hook.result.current.authority.setSelection({
      surface: 'assets',
      ids: [1],
      edges: [],
      group: null,
    })
  })
  await act(async () => {
    resolveImage({ id: 1, missing: false, trashed: false } as never)
    await expect(submit).rejects.toThrow('The selection changed')
  })
  expect(addTag).not.toHaveBeenCalled()
  expect(reload).not.toHaveBeenCalled()
  expect(groupMembers).not.toHaveBeenCalled()
})
