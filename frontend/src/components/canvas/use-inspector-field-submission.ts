import { t } from '@lingui/core/macro'
import { type MutableRefObject, useCallback } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import type { CanvasBoardOwner } from './canvas-board-owner'
import {
  type CanvasOperationContext,
  unwrapCanvasOutcome,
} from './canvas-operation'
import { canvasEffects } from './canvas-operation-effects'

interface Props {
  owner: CanvasBoardOwner
  repoPath: string
  selection: Selection
  selectedIds: number[]
  selectionRef: MutableRefObject<Selection>
  groupMembers: (id: number) => number[]
  fieldSubmissionPending: MutableRefObject<boolean>
  submissionScopeRef: MutableRefObject<{ key: string; revision: number }>
}

export function useInspectorFieldSubmission({
  owner,
  repoPath,
  selection,
  selectedIds,
  selectionRef,
  groupMembers,
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
      return owner
        .submit(
          {
            kind: 'mutation',
            capability: 'metadata',
            board: owner.getSnapshot(),
          },
          (context) =>
            submitFieldValue({
              context,
              command,
              value,
              imageIds,
              expected,
              repoPath,
              selection,
              selectedIds,
              selectionRef,
              groupMembers,
              submissionScopeRef,
            })
        )
        .then(unwrapCanvasOutcome)
        .finally(() => {
          fieldSubmissionPending.current = false
        })
    },
    [
      repoPath,
      owner,
      selection,
      selectedIds,
      selectionRef,
      groupMembers,
      fieldSubmissionPending,
      submissionScopeRef,
    ]
  )
}

interface SubmitFieldValueProps {
  context: CanvasOperationContext
  command: 'move-rename-file' | 'add-tag' | 'save-prompt'
  value: string
  imageIds: number[]
  expected?: { owner: Selection['surface']; revision: number }
  repoPath: string
  selection: Selection
  selectedIds: number[]
  selectionRef: MutableRefObject<Selection>
  groupMembers: (id: number) => number[]
  submissionScopeRef: MutableRefObject<{ key: string; revision: number }>
}

async function submitFieldValue({
  command,
  context,
  value,
  imageIds,
  expected,
  repoPath,
  selection,
  selectedIds,
  selectionRef,
  groupMembers,
  submissionScopeRef,
}: SubmitFieldValueProps) {
  const revision = submissionScopeRef.current.revision
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
  const records = await context.prepare(() =>
    Promise.all(ids.map((id) => ImageService.GetImage(repoPath, id)))
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
    await moveFile(context, value, ids, repoPath, records)
    return
  }
  if (command === 'add-tag') {
    await addTag(context, value, ids, repoPath)
    return
  }
  await savePrompt(context, value, ids, repoPath)
}

async function moveFile(
  context: CanvasOperationContext,
  value: string,
  ids: number[],
  repoPath: string,
  records: Awaited<ReturnType<typeof ImageService.GetImage>>[]
) {
  const path = value.trim()
  if (
    ids.length !== 1 ||
    !path ||
    path === records[0]?.filePath.slice(repoPath.length + 1)
  ) {
    return
  }
  const image = records[0]
  if (!image || image.missing || image.trashed)
    throw new Error(t`This file cannot be moved in its current state.`)
  await canvasEffects.moveFile(context, repoPath, ids[0], path)
}

async function addTag(
  context: CanvasOperationContext,
  value: string,
  ids: number[],
  repoPath: string
) {
  const tag = value.trim()
  if (!tag) {
    return
  }
  const results = await context.prepare(() =>
    Promise.allSettled(
      ids.map((id) => canvasEffects.addTag(context, repoPath, id, tag))
    )
  )
  const failedIds = results.flatMap((result, index) =>
    result.status === 'rejected' ? [ids[index]] : []
  )
  if (failedIds.length)
    throw new Error(
      t`${ids.length - failedIds.length} of ${ids.length} assets updated; failed asset IDs: ${failedIds.join(', ')}. The current state was refreshed.`
    )
}

async function savePrompt(
  context: CanvasOperationContext,
  value: string,
  ids: number[],
  repoPath: string
) {
  const results = await context.prepare(() =>
    Promise.allSettled(
      ids.map((id) =>
        value === ''
          ? canvasEffects.detachPrompt(context, repoPath, id)
          : canvasEffects.createAndAttachPrompt(
              context,
              repoPath,
              id,
              '',
              value,
              ''
            )
      )
    )
  )
  const failedIds = results.flatMap((result, index) =>
    result.status === 'rejected' ? [ids[index]] : []
  )
  if (failedIds.length)
    throw new Error(
      t`${ids.length - failedIds.length} of ${ids.length} assets updated; failed asset IDs: ${failedIds.join(', ')}. The current state was refreshed.`
    )
}
