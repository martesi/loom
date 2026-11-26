import type { ReactFlowInstance, XYPosition } from '@xyflow/react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useEffect, useRef } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { readMedia } from '../../lib/clipboard'
import { type Selection, sameSelection } from '../../lib/selection'
import type {
  CanvasBoardOwner,
  CanvasOperationIntent,
} from './canvas-board-owner'
import type { CanvasCapability, CanvasInternalMode } from './canvas-mode-policy'
import type { RevealRequest } from './use-canvas-workspace-state'

export interface CanvasAssetIntent {
  owner: CanvasBoardOwner
  repoPath: string
  mode: CanvasInternalMode
  modeRevision: number
  navigationGeneration: number
  operation: CanvasOperationIntent
}

interface Props {
  repoPath: string
  owner: CanvasBoardOwner
  flow: ReactFlowInstance
  selection: Selection
  setSelection: Dispatch<SetStateAction<Selection>>
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
  setSelection,
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
  const purgeOrigin = useRef<Selection['surface'] | null>(null)
  const navigationActive = useRef(true)
  const navigation = useRef({ generation: 0, owner, repoPath, selection })
  const previous = navigation.current
  if (
    previous.owner !== owner ||
    previous.repoPath !== repoPath ||
    !sameSelection(previous.selection, selection)
  ) {
    navigation.current = {
      generation: previous.generation + 1,
      owner,
      repoPath,
      selection,
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
      operation: owner.captureIntent(capability, navigation.current.generation),
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
    const isOwnerCurrent = () =>
      navigationActive.current &&
      navigation.current.owner === owner &&
      navigation.current.repoPath === repoPath &&
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
    if (!isCurrent()) return
    const zoom = flow.getZoom()
    if (!isCurrent()) return
    await flow.setCenter(
      node
        ? node.position.x + (node.measured?.width ?? node.width ?? 150) / 2
        : image.canvasX + 75,
      node
        ? node.position.y + (node.measured?.height ?? node.height ?? 110) / 2
        : image.canvasY + 55,
      {
        zoom,
      }
    )
  }

  async function paste(
    media?: Awaited<ReturnType<typeof readMedia>>,
    surface = selection.surface,
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
    setSelection({
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
    setSelection({ surface: 'assets', ids: ids ?? [], edges: [], group: null })
    if (ids?.length) setReveal({ id: ids[0], folder: null })
  }

  async function remove(purge: boolean) {
    const ids = selectedIds()
    if (purge) {
      if (owner.getMode() !== 'legacy' && selection.surface !== 'assets') return
      if (ids.length) {
        purgeOrigin.current = selection.surface
        setPurgeIds(ids)
      }
      return
    }
    if (selection.surface === 'assets') {
      confirmTrash(ids)
      return
    }
    if (selection.edges.length) {
      if (!owner.allows('relationship')) return
      const intent = captureIntent('relationship')
      await ImageService.UnlinkSources(repoPath, selection.edges)
      if (!isCurrentIntent(intent)) return
    } else return
    setSelection({ ...selection, ids: [], edges: [], group: null })
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
    const result = await owner.executeIntent(
      intent.operation,
      () => isCurrentIntent(intent),
      () =>
        Promise.allSettled(
          ids.map((id) => ImageService.TrashImage(repoPath, id))
        ),
      true
    )
    if (!result.dispatched || !isCurrentIntent(intent)) return
    const outcomes = result.value ?? []
    const failures = outcomes.flatMap((outcome, index) =>
      outcome.status === 'rejected'
        ? [{ id: ids[index], cause: outcome.reason }]
        : []
    )
    setTrashIds(null)
    setSelection({ ...selection, ids: [], edges: [], group: null })
    for (const failure of failures)
      console.error('asset trash failed', {
        assetId: failure.id,
        cause: failure.cause,
      })
    if (failures.length) {
      const details = failures.map(
        ({ id, cause }) =>
          `Asset ${id}: ${cause instanceof Error ? cause.message : String(cause)}`
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
    setSelection({ ...selection, ids: [], edges: [], group: null })
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
