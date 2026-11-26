import { t } from '@lingui/core/macro'
import { type MutableRefObject, useCallback } from 'react'
import {
  ImageService,
  PromptService,
  TagService,
} from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import type { CanvasSelectionIntentRef } from './canvas-selection-intent'

interface Props {
  repoPath: string
  selectionRef: MutableRefObject<Selection>
  groupMembers: (id: number) => number[]
  reload: () => Promise<void>
  fieldSubmissionPending: MutableRefObject<boolean>
  submissionScopeRef: CanvasSelectionIntentRef
}

export function useInspectorFieldSubmission({
  repoPath,
  selectionRef,
  groupMembers,
  reload,
  fieldSubmissionPending,
  submissionScopeRef,
}: Props) {
  return useCallback(
    async function submitInspectorField(
      command: 'move-rename-file' | 'add-tag' | 'save-prompt',
      value: string,
      imageIds: number[],
      _fileName?: string,
      expected?: { owner: Selection['surface']; revision: number }
    ) {
      if (fieldSubmissionPending.current)
        throw new Error(t`A save is already in progress.`)
      fieldSubmissionPending.current = true
      return submitFieldValue({
        command,
        value,
        imageIds,
        expected,
        repoPath,
        selection: selectionRef.current,
        selectedIds: selectionRef.current.ids,
        selectionRef,
        groupMembers,
        reload,
        submissionScopeRef,
      }).finally(() => {
        fieldSubmissionPending.current = false
      })
    },
    [
      repoPath,
      selectionRef,
      groupMembers,
      reload,
      fieldSubmissionPending,
      submissionScopeRef,
    ]
  )
}

interface SubmitFieldValueProps {
  command: 'move-rename-file' | 'add-tag' | 'save-prompt'
  value: string
  imageIds: number[]
  expected?: { owner: Selection['surface']; revision: number }
  repoPath: string
  selection: Selection
  selectedIds: number[]
  selectionRef: MutableRefObject<Selection>
  groupMembers: (id: number) => number[]
  reload: () => Promise<void>
  submissionScopeRef: CanvasSelectionIntentRef
}

async function submitFieldValue({
  command,
  value,
  imageIds,
  expected,
  repoPath,
  selection,
  selectedIds,
  selectionRef,
  groupMembers,
  reload,
  submissionScopeRef,
}: SubmitFieldValueProps) {
  const revision = submissionScopeRef.current.revision
  const targetRevision = submissionScopeRef.current.targetRevision
  const ids = [...new Set(imageIds)].sort((a, b) => a - b)
  const currentIds = [...new Set(selectedIds)].sort((a, b) => a - b)
  const owner = selection.surface
  if (
    !ids.length ||
    ids.length !== imageIds.length ||
    ids.some((id, index) => id !== currentIds[index]) ||
    ids.length !== currentIds.length
  )
    throw new Error(
      t`The selection changed. Review the Inspector and try again.`
    )
  const records = await Promise.all(
    ids.map((id) => ImageService.GetImage(repoPath, id))
  )
  const liveIds = [
    ...new Set([
      ...selectionRef.current.ids,
      ...(selectionRef.current.group
        ? groupMembers(selectionRef.current.group)
        : []),
    ]),
  ].sort((a, b) => a - b)
  if (
    submissionScopeRef.current.revision !== revision ||
    submissionScopeRef.current.targetRevision !== targetRevision ||
    (expected &&
      (expected.owner !== owner || expected.revision !== revision)) ||
    selectionRef.current.surface !== owner ||
    ids.length !== liveIds.length ||
    ids.some((id, index) => id !== liveIds[index]) ||
    records.some((record) => !record)
  )
    throw new Error(
      t`The selection changed or some assets are unavailable. No changes were made.`
    )
  if (command === 'move-rename-file') {
    await moveFile(value, ids, repoPath, records, reload)
    return
  }
  if (command === 'add-tag') {
    await addTag(value, ids, repoPath, reload)
    return
  }
  await savePrompt(value, ids, repoPath, reload)
}

async function moveFile(
  value: string,
  ids: number[],
  repoPath: string,
  records: Awaited<ReturnType<typeof ImageService.GetImage>>[],
  reload: () => Promise<void>
) {
  const path = value.trim()
  if (
    ids.length !== 1 ||
    !path ||
    path === records[0]?.filePath.slice(repoPath.length + 1)
  )
    return
  const image = records[0]
  if (!image || image.missing || image.trashed)
    throw new Error(t`This file cannot be moved in its current state.`)
  await ImageService.MoveFile(repoPath, ids[0], path)
  await reload()
}

async function addTag(
  value: string,
  ids: number[],
  repoPath: string,
  reload: () => Promise<void>
) {
  const tag = value.trim()
  if (!tag) return
  const results = await Promise.allSettled(
    ids.map((id) => TagService.AddTag(repoPath, id, tag))
  )
  const failedIds = results.flatMap((result, index) =>
    result.status === 'rejected' ? [ids[index]] : []
  )
  await reload()
  if (failedIds.length)
    throw new Error(
      t`${ids.length - failedIds.length} of ${ids.length} assets updated; failed asset IDs: ${failedIds.join(', ')}. The current state was refreshed.`
    )
}

async function savePrompt(
  value: string,
  ids: number[],
  repoPath: string,
  reload: () => Promise<void>
) {
  const results = await Promise.allSettled(
    ids.map((id) =>
      value === ''
        ? PromptService.DetachPrompt(repoPath, id)
        : PromptService.CreateAndAttachPrompt(repoPath, id, '', value, '')
    )
  )
  const failedIds = results.flatMap((result, index) =>
    result.status === 'rejected' ? [ids[index]] : []
  )
  await reload()
  if (failedIds.length)
    throw new Error(
      t`${ids.length - failedIds.length} of ${ids.length} assets updated; failed asset IDs: ${failedIds.join(', ')}. The current state was refreshed.`
    )
}
