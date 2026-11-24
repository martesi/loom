import type { ReactFlowInstance } from '@xyflow/react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import {
  GroupService,
  ImageService,
} from '../../../bindings/loom/internal/service'
import { readMedia } from '../../lib/clipboard'
import type { Selection } from '../../lib/selection'
import type { RevealRequest } from './use-canvas-workspace-state'

interface Props {
  repoPath: string
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
  canCreateSet: boolean
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
  canCreateSet,
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
  async function createSet() {
    if (!canCreateSet) return
    const ids = selection.ids
    const created = await GroupService.CreateGroup(repoPath, '', '', ids)
    if (!created) return
    await reload()
    // Keep the new semantic set selected after its metadata reloads.
    setSelection({ surface: 'canvas', ids, edges: [], group: created.id })
  }

  async function go(id: number, folder = false) {
    const image = await ImageService.GetImage(repoPath, id)
    if (!image) return
    if (folder || !image.placed) {
      openAssets()
      selectAssets([id])
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
    setExpanded(image.groupId || null)
    setSelection({ surface: 'canvas', ids: [id], edges: [], group: null })
    await flow.setCenter(image.canvasX + 75, image.canvasY + 55, {
      zoom: flow.getZoom(),
    })
  }

  async function paste(
    media?: Awaited<ReturnType<typeof readMedia>>,
    surface = selection.surface
  ) {
    const point = center()
    const assets = media ?? (await readMedia())
    const canvas = surface === 'canvas'
    const ids = await ImageService.ImportMedia(
      repoPath,
      assets,
      canvas,
      point.x,
      point.y
    )
    await reload()
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
      if (ids.length) setPurgeIds(ids)
      return
    }
    if (selection.surface === 'assets') {
      confirmTrash(ids)
      return
    }
    if (selection.edges.length) {
      await ImageService.UnlinkSources(repoPath, selection.edges)
    } else if (ids.length) {
      await ImageService.UnplaceImages(repoPath, ids)
    }
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
    lifecyclePendingRef.current = true
    setLifecyclePending(true)
    await ImageService.PurgeImages(repoPath, purgeIds)
    setPurgeIds(null)
    setSelection({ ...selection, ids: [], edges: [], group: null })
    await reload()
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
    createSet,
    go,
    paste,
    importMedia,
    remove,
    confirmTrash,
    finishTrash,
    confirmPurge,
  }
}
