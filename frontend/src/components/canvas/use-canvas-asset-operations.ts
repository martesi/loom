import type { ReactFlowInstance, XYPosition } from '@xyflow/react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useEffect, useRef } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { readMedia } from '../../lib/clipboard'
import type { Selection } from '../../lib/selection'
import type {
  CanvasBoardOwner,
  CanvasOperationIntent,
} from './canvas-board-owner'
import type { CanvasCapability, CanvasInternalMode } from './canvas-mode-policy'
import {
  type CanvasSelectionIntentRef,
  createCanvasSelectionIntentRef,
} from './canvas-selection-intent'
import {
  captureCanvasTrashCompletion,
  collectCanvasTrashFailures,
  countCanvasTrashUnknownOutcomes,
  executeCanvasTrashBatch,
} from './canvas-trash-outcomes'
import type { CanvasViewportCommand } from './use-canvas-projection-controller'
import type { RevealRequest } from './use-canvas-workspace-state'

export interface CanvasAssetIntent {
  owner: CanvasBoardOwner
  repoPath: string
  mode: CanvasInternalMode
  modeRevision: number
  navigationGeneration: number
  selectionRevision: number
  selectionTargetRevision: number
  operation: CanvasOperationIntent
}

interface Props {
  repoPath: string
  owner: CanvasBoardOwner
  flow: ReactFlowInstance
  selection?: Selection
  selectionRef?: MutableRefObject<Selection>
  selectionIntentRef?: CanvasSelectionIntentRef
  host?: MutableRefObject<HTMLDivElement | null>
  beginViewportCommand?: () => CanvasViewportCommand
  isViewportCommandCurrent?: (command: CanvasViewportCommand) => boolean
  persistViewportCommand?: (
    command: CanvasViewportCommand,
    viewport: import('@xyflow/react').Viewport
  ) => Promise<boolean>
  cancelViewportCommand?: (command: CanvasViewportCommand) => void
  setSelection: Dispatch<SetStateAction<Selection>>
  setSelectionFromOperation?: Dispatch<SetStateAction<Selection>>
  selectedIds: () => number[]
  setExpanded: Dispatch<SetStateAction<number | null>>
  openAssets: () => void
  selectAssets: (ids: number[]) => void
  setReveal: Dispatch<SetStateAction<RevealRequest | null>>
  center: () => { x: number; y: number }
  purgeIds: number[] | null
  trashIds: number[] | null
  setPurgeIds: Dispatch<SetStateAction<number[] | null>>
  setTrashIds: Dispatch<SetStateAction<number[] | null>>
  lifecyclePendingRef: MutableRefObject<boolean>
  setLifecyclePending: Dispatch<SetStateAction<boolean>>
  pendingRecentAction: MutableRefObject<string | null>
  setRecentActionIds: Dispatch<SetStateAction<string[]>>
  setError: Dispatch<SetStateAction<string>>
}

export function useCanvasAssetOperations({
  repoPath,
  owner,
  flow,
  selection,
  host,
  beginViewportCommand,
  isViewportCommandCurrent,
  persistViewportCommand,
  cancelViewportCommand,
  selectionRef,
  selectionIntentRef,
  setSelection,
  setSelectionFromOperation,
  selectedIds,
  setExpanded,
  openAssets,
  selectAssets,
  setReveal,
  center,
  purgeIds,
  trashIds,
  setPurgeIds,
  setTrashIds,
  lifecyclePendingRef,
  setLifecyclePending,
  pendingRecentAction,
  setRecentActionIds,
  setError,
}: Props) {
  const fallbackSelectionRef = useRef<Selection>(
    selection ?? { surface: 'canvas', ids: [], edges: [], group: null }
  )
  const currentSelectionRef = selectionRef ?? fallbackSelectionRef
  const fallbackIntentRef = useRef(
    createCanvasSelectionIntentRef(repoPath, fallbackSelectionRef.current)
  ).current
  const currentSelectionIntentRef = selectionIntentRef ?? fallbackIntentRef
  const publishSelectionFromOperation =
    setSelectionFromOperation ?? setSelection
  const purgeOrigin = useRef<Selection['surface'] | null>(null)
  const navigationActive = useRef(true)
  const navigation = useRef({ generation: 0, owner, repoPath })
  if (
    navigation.current.owner !== owner ||
    navigation.current.repoPath !== repoPath
  ) {
    navigation.current = {
      generation: navigation.current.generation + 1,
      owner,
      repoPath,
    }
  }
  useEffect(() => {
    navigationActive.current = true
    return () => {
      navigationActive.current = false
      navigation.current.generation++
    }
  }, [])
  function captureIntent(
    capability: CanvasCapability = 'lifecycle'
  ): CanvasAssetIntent {
    return {
      owner,
      repoPath,
      mode: owner.getMode(),
      modeRevision: owner.getModeRevision(),
      navigationGeneration: navigation.current.generation,
      selectionRevision: currentSelectionIntentRef.current.revision,
      selectionTargetRevision: currentSelectionIntentRef.current.targetRevision,
      operation: owner.captureIntent(
        capability,
        currentSelectionIntentRef.current.revision
      ),
    }
  }
  function isCurrentIntent(intent: CanvasAssetIntent) {
    return (
      navigationActive.current &&
      intent.owner === owner &&
      intent.repoPath === repoPath &&
      navigation.current.owner === owner &&
      navigation.current.repoPath === repoPath &&
      navigation.current.generation === intent.navigationGeneration &&
      currentSelectionIntentRef.current.revision === intent.selectionRevision &&
      currentSelectionIntentRef.current.targetRevision ===
        intent.selectionTargetRevision &&
      owner.isActive?.() !== false &&
      owner.getMode() === intent.mode &&
      owner.getModeRevision() === intent.modeRevision &&
      owner.isIntentCurrent(
        intent.operation,
        () =>
          navigationActive.current &&
          navigation.current.owner === intent.owner &&
          navigation.current.repoPath === intent.repoPath &&
          navigation.current.generation === intent.navigationGeneration
      )
    )
  }
  // A retained callback must keep the revision from the render that created it.
  const modeRevision = owner.getModeRevision()
  async function go(id: number, folder = false) {
    let selectionRevision = currentSelectionIntentRef.current.revision
    let selectionTargetRevision =
      currentSelectionIntentRef.current.targetRevision
    const isOwnerCurrent = () =>
      navigationActive.current &&
      navigation.current.owner === owner &&
      navigation.current.repoPath === repoPath &&
      currentSelectionIntentRef.current.revision === selectionRevision &&
      currentSelectionIntentRef.current.targetRevision ===
        selectionTargetRevision &&
      owner.isActive?.() !== false &&
      owner.getModeRevision() === modeRevision
    if (!isOwnerCurrent()) return
    const request = ++navigation.current.generation
    const isCurrent = () =>
      navigation.current.generation === request && isOwnerCurrent()
    const image = await ImageService.GetImage(repoPath, id)
    if (!isCurrent() || !image) return
    const mode = owner.getMode()
    const node = mode === 'legacy' ? undefined : flow.getNode(String(id))
    if (!isCurrent()) return
    if (folder || (mode === 'legacy' ? !image.placed : !node)) {
      openAssets()
      if (!isCurrent()) return
      selectAssets([id])
      selectionRevision = currentSelectionIntentRef.current.revision
      selectionTargetRevision = currentSelectionIntentRef.current.targetRevision
      if (!isCurrent()) return
      setReveal({
        id,
        folder: folder
          ? image.filePath
              .slice(repoPath.length + 1)
              .split('/')
              .slice(0, -1)
              .join('/')
          : null,
      })
      return
    }
    setExpanded(null)
    if (!isCurrent()) return
    setSelection({ surface: 'canvas', ids: [id], edges: [], group: null })
    selectionRevision = currentSelectionIntentRef.current.revision
    selectionTargetRevision = currentSelectionIntentRef.current.targetRevision
    if (!isCurrent()) return
    const zoom = flow.getZoom()
    if (!isCurrent()) return
    const centerX = node
      ? node.position.x + (node.measured?.width ?? node.width ?? 150) / 2
      : image.canvasX + 75
    const centerY = node
      ? node.position.y + (node.measured?.height ?? node.height ?? 110) / 2
      : image.canvasY + 55
    const command = beginViewportCommand?.()
    if (command) await command.waitForViewport
    const commandCurrent = () =>
      !command || (isViewportCommandCurrent?.(command) ?? true)
    if (!isCurrent() || !commandCurrent()) {
      if (command) cancelViewportCommand?.(command)
      return
    }
    const bounds = host?.current?.getBoundingClientRect()
    if (!flow.setViewport) return
    const applied = await flow.setViewport(
      {
        x: (bounds?.width ?? 0) / 2 - centerX * zoom,
        y: (bounds?.height ?? 0) / 2 - centerY * zoom,
        zoom,
      },
      { duration: 0 }
    )
    if (!applied || !isCurrent() || !commandCurrent()) {
      if (command) cancelViewportCommand?.(command)
      return
    }
    if (command) await persistViewportCommand?.(command, flow.getViewport())
  }

  async function paste(
    media?: Awaited<ReturnType<typeof readMedia>>,
    surface = currentSelectionRef.current.surface,
    dropPosition?: XYPosition,
    intent = captureIntent()
  ) {
    if (!isCurrentIntent(intent)) return
    const point = dropPosition ?? center()
    const assets = media ?? (await readMedia())
    if (!isCurrentIntent(intent)) return
    const result = await owner.executeIntent(
      intent.operation,
      () => isCurrentIntent(intent),
      async () => {
        const canvas = surface === 'canvas' && owner.allows('canvas-drop')
        const ids = await ImageService.ImportMedia(
          repoPath,
          assets,
          canvas,
          point.x,
          point.y
        )
        return { ids, canvas }
      },
      true
    )
    if (!result.dispatched || !isCurrentIntent(intent)) return
    const { ids, canvas } = result.value ?? { ids: null, canvas: false }
    publishSelectionFromOperation({
      surface: canvas ? 'canvas' : 'assets',
      ids: ids ?? [],
      edges: [],
      group: null,
    })
    if (!canvas && ids?.length) setReveal({ id: ids[0], folder: null })
  }

  async function importMedia(
    media: Awaited<ReturnType<typeof readMedia>>,
    intent = captureIntent()
  ) {
    if (!isCurrentIntent(intent)) return
    const result = await owner.executeIntent(
      intent.operation,
      () => isCurrentIntent(intent),
      () => ImageService.ImportMedia(repoPath, media, false, 0, 0),
      true
    )
    const ids = result.value
    if (!result.dispatched || !isCurrentIntent(intent)) return
    publishSelectionFromOperation({
      surface: 'assets',
      ids: ids ?? [],
      edges: [],
      group: null,
    })
    if (ids?.length) setReveal({ id: ids[0], folder: null })
  }

  async function remove(purge: boolean) {
    const currentSelection = currentSelectionRef.current
    const ids = selectedIds()
    if (purge) {
      if (owner.getMode() !== 'legacy' && currentSelection.surface !== 'assets')
        return
      if (ids.length) {
        purgeOrigin.current = currentSelection.surface
        setPurgeIds(ids)
      }
      return
    }
    if (currentSelection.surface === 'assets') {
      confirmTrash(ids)
      return
    }
    if (currentSelection.edges.length) {
      if (!owner.allows('relationship')) return
      const intent = captureIntent('relationship')
      await ImageService.UnlinkSources(repoPath, currentSelection.edges)
      if (!isCurrentIntent(intent)) return
    } else return
    publishSelectionFromOperation((current) => ({
      ...current,
      ids: [],
      edges: [],
      group: null,
    }))
  }

  function confirmTrash(ids: number[]) {
    if (ids.length) setTrashIds(ids)
  }

  async function finishTrash() {
    if (!trashIds?.length || lifecyclePendingRef.current) return
    const ids = [...trashIds]
    const intent = captureIntent('lifecycle')
    lifecyclePendingRef.current = true
    setLifecyclePending(true)
    const completion = await captureCanvasTrashCompletion(
      owner.executeIntent(
        intent.operation,
        () => isCurrentIntent(intent),
        () => executeCanvasTrashBatch(repoPath, ids),
        true
      )
    )
    lifecyclePendingRef.current = false
    setLifecyclePending(false)
    const failures = collectCanvasTrashFailures(completion.outcomes)
    if (completion.status === 'failed') {
      if (isCurrentIntent(intent)) {
        setTrashIds(null)
        const unknownCount = countCanvasTrashUnknownOutcomes(
          completion.outcomes
        )
        setError(
          unknownCount > 0
            ? `${unknownCount} of ${ids.length} trash requests have an unknown outcome. Canvas editing remains blocked until the write outcome is authoritatively settled.`
            : String(completion.error)
        )
      }
      return
    }
    if (!completion.result.dispatched || !isCurrentIntent(intent)) return
    setTrashIds(null)
    publishSelectionFromOperation((current) => ({
      ...current,
      ids: [],
      edges: [],
      group: null,
    }))
    if (failures.length) {
      const details = failures.map(
        ({ id, error }) =>
          `Asset ${id}: ${error instanceof Error ? error.message : String(error)}`
      )
      setError(
        `${ids.length - failures.length} of ${ids.length} assets moved to Trash. ${details.join('; ')} The current state was refreshed.`
      )
      return
    }
    completeLifecycleAction()
  }

  async function confirmPurge() {
    if (!purgeIds?.length || lifecyclePendingRef.current) return
    if (owner.getMode() !== 'legacy' && purgeOrigin.current !== 'assets') return
    lifecyclePendingRef.current = true
    setLifecyclePending(true)
    const intent = captureIntent('lifecycle')
    const ids = [...purgeIds]
    const result = await owner.executeIntent(
      intent.operation,
      () =>
        isCurrentIntent(intent) &&
        (owner.getMode() === 'legacy' || purgeOrigin.current === 'assets'),
      () => ImageService.PurgeImages(repoPath, ids),
      true
    )
    if (!result.dispatched || !isCurrentIntent(intent)) return
    purgeOrigin.current = null
    setPurgeIds(null)
    publishSelectionFromOperation((current) => ({
      ...current,
      ids: [],
      edges: [],
      group: null,
    }))
    completeLifecycleAction()
  }

  function completeLifecycleAction() {
    const actionId = pendingRecentAction.current
    pendingRecentAction.current = null
    if (actionId)
      setRecentActionIds((ids) =>
        [actionId, ...ids.filter((id) => id !== actionId)].slice(0, 6)
      )
  }

  return {
    captureIntent,
    isCurrentIntent,
    go,
    paste,
    importMedia,
    remove,
    confirmTrash,
    finishTrash,
    confirmPurge,
  }
}
