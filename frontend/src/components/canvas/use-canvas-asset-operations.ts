import type { ReactFlowInstance } from '@xyflow/react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useEffect, useRef } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { readMedia } from '../../lib/clipboard'
import type { Selection } from '../../lib/selection'
import type { CanvasBoardOwner } from './canvas-board-owner'
import type { RevealRequest } from './use-canvas-workspace-state'

interface Props {
  repoPath: string
  owner: CanvasBoardOwner
  flow: ReactFlowInstance
  selection: Selection
  setSelection: Dispatch<SetStateAction<Selection>>
  selectedIds: () => number[]
  reload: () => Promise<void>
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
  reload,
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
    surface = selection.surface
  ) {
    const point = center()
    const assets = media ?? (await readMedia())
    const { ids, canvas } = await owner.execute(async () => {
      const canvas = surface === 'canvas' && owner.allows('canvas-drop')
      const ids = await ImageService.ImportMedia(
        repoPath,
        assets,
        canvas,
        point.x,
        point.y
      )
      await reload()
      return { ids, canvas }
    })
    setSelection({
      surface: canvas ? 'canvas' : 'assets',
      ids: ids ?? [],
      edges: [],
      group: null,
    })
    if (!canvas && ids?.length) setReveal({ id: ids[0], folder: null })
  }

  async function importMedia(media: Awaited<ReturnType<typeof readMedia>>) {
    const ids = await ImageService.ImportMedia(repoPath, media, false, 0, 0)
    await reload()
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
      await ImageService.UnlinkSources(repoPath, selection.edges)
    } else return
    setSelection({ ...selection, ids: [], edges: [], group: null })
    await reload()
  }

  function confirmTrash(ids: number[]) {
    if (ids.length) setTrashIds(ids)
  }

  async function finishTrash() {
    if (!trashIds?.length || lifecyclePendingRef.current) return
    lifecyclePendingRef.current = true
    setLifecyclePending(true)
    const outcomes = await Promise.allSettled(
      trashIds.map((id) => ImageService.TrashImage(repoPath, id))
    )
    const failures = outcomes.flatMap((outcome, index) =>
      outcome.status === 'rejected'
        ? [{ id: trashIds[index], cause: outcome.reason }]
        : []
    )
    setTrashIds(null)
    setSelection({ ...selection, ids: [], edges: [], group: null })
    let refreshError: unknown
    await reload().then(
      () => undefined,
      (cause: unknown) => {
        refreshError = cause
      }
    )
    for (const failure of failures)
      console.error('asset trash failed', {
        assetId: failure.id,
        cause: failure.cause,
      })
    if (refreshError)
      console.error('asset trash refresh failed', { cause: refreshError })
    if (failures.length || refreshError) {
      const details = failures.map(
        ({ id, cause }) =>
          `Asset ${id}: ${cause instanceof Error ? cause.message : String(cause)}`
      )
      setError(
        `${trashIds.length - failures.length} of ${trashIds.length} assets moved to Trash.${details.length ? ` ${details.join('; ')}` : ''}${refreshError ? ' Refresh failed; the current state may be stale.' : ' The current state was refreshed.'}`
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
    const purged = await owner.execute(async () => {
      if (owner.getMode() !== 'legacy' && purgeOrigin.current !== 'assets')
        return false
      await ImageService.PurgeImages(repoPath, purgeIds)
      await reload()
      return true
    })
    if (!purged) return
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
    go,
    paste,
    importMedia,
    remove,
    confirmTrash,
    finishTrash,
    confirmPurge,
  }
}

function sameSelection(a: Selection, b: Selection) {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.surface === b.surface &&
    a.group === b.group &&
    a.ids.length === b.ids.length &&
    a.edges.length === b.edges.length &&
    a.ids.every((id, index) => id === b.ids[index]) &&
    a.edges.every((id, index) => id === b.edges[index])
  )
}
