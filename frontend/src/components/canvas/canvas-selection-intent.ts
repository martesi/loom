import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useRef, useState } from 'react'
import { emptySelection, type Selection } from '../../lib/selection'
import type {
  CanvasBoardOwner,
  CanvasOperationIntent,
} from './canvas-board-owner'

export interface CanvasSelectionIntentState {
  key: string
  revision: number
  targetRevision: number
}

export interface CanvasSelectionIntentRef {
  current: CanvasSelectionIntentState
}

export function createCanvasSelectionIntentRef(
  repoPath: string,
  selection: Selection = emptySelection
): CanvasSelectionIntentRef {
  return {
    current: {
      key: canvasSelectionKey(repoPath, selection),
      revision: 0,
      targetRevision: 0,
    },
  }
}

export function useCanvasSelectionAuthority(
  repoPath: string,
  initialSelection: Selection = emptySelection
) {
  const [selection, setSelectionState] = useState(initialSelection)
  const selectionRef = useRef(initialSelection)
  const intentRef = useRef(
    createCanvasSelectionIntentRef(repoPath, initialSelection)
  ).current
  const publish = useCallback(
    (action: SetStateAction<Selection>, userEvent: boolean) => {
      const previous = selectionRef.current
      const next = typeof action === 'function' ? action(previous) : action
      const key = canvasSelectionKey(repoPath, next)
      selectionRef.current = next
      if (key !== intentRef.current.key)
        publishCanvasSelectionTarget(intentRef, key, userEvent)
      setSelectionState(next)
    },
    [repoPath, intentRef]
  )
  const setSelection: Dispatch<SetStateAction<Selection>> = useCallback(
    (action) => publish(action, true),
    [publish]
  )
  const setSelectionInternal: Dispatch<SetStateAction<Selection>> = useCallback(
    (action) => publish(action, false),
    [publish]
  )
  return {
    selection,
    selectionRef,
    intentRef,
    setSelection,
    setSelectionInternal,
    setSelectionFromOperation: setSelectionInternal,
  }
}

export interface CapturedCanvasSelectionIntent {
  revision: number
  targetRevision: number
  key: string
  operation: CanvasOperationIntent
}

export function canvasSelectionKey(
  repoPath: string,
  selection: import('../../lib/selection').Selection
) {
  return `${repoPath}\u0000${selection.surface}\u0000${selection.ids
    .slice()
    .sort((a, b) => a - b)
    .join(',')}\u0000${selection.edges
    .slice()
    .sort((a, b) => a - b)
    .join(',')}\u0000${selection.group ?? ''}`
}

export function publishCanvasSelectionTarget(
  reference: CanvasSelectionIntentRef,
  key: string,
  userEvent: boolean
) {
  if (reference.current.key === key) return reference.current
  reference.current = {
    key,
    revision: reference.current.revision + Number(userEvent),
    targetRevision: (reference.current.targetRevision ?? 0) + 1,
  }
  return reference.current
}

export function advanceCanvasSelectionEvent(
  reference: CanvasSelectionIntentRef
) {
  reference.current = {
    ...reference.current,
    revision: reference.current.revision + 1,
  }
  return reference.current.revision
}

export function captureCanvasSelectionIntent(
  owner: CanvasBoardOwner,
  reference: CanvasSelectionIntentRef
): CapturedCanvasSelectionIntent {
  const revision = reference.current.revision
  return {
    revision,
    targetRevision: reference.current.targetRevision,
    key: reference.current.key,
    operation: owner.captureIntent('relationship', revision),
  }
}

export function isCanvasSelectionIntentCurrent(
  reference: CanvasSelectionIntentRef,
  intent: Pick<
    CapturedCanvasSelectionIntent,
    'revision' | 'targetRevision' | 'key'
  >
) {
  return (
    reference.current.revision === intent.revision &&
    reference.current.targetRevision === intent.targetRevision &&
    reference.current.key === intent.key
  )
}
