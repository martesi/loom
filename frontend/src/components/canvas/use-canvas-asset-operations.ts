import type { ReactFlowInstance } from '@xyflow/react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useEffect, useRef } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { readMedia } from '../../lib/clipboard'
import type { Selection } from '../../lib/selection'
import type { CanvasBoardOwner } from './canvas-board-owner'
import { unwrapCanvasOutcome } from './canvas-operation'
import { canvasEffects } from './canvas-operation-effects'
import type { RevealRequest } from './use-canvas-workspace-state'

type Media = Awaited<ReturnType<typeof readMedia>>

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
    media?: Media | (() => Promise<Media>),
    surface = selection.surface
  ) {
    const point = center()
    let prepared: Promise<Media> | null = null
    const outcome = await owner.submit(
      {
        kind: 'mutation',
        capability: 'lifecycle',
        board: owner.getSnapshot(),
      },
      async (context) => {
        const source = prepared
        if (!source) throw new Error('Clipboard preparation did not start.')
        const assets = await context.prepare(() => source)
        const canvas = surface === 'canvas' && owner.getMode() !== 'view'
        const ids = await canvasEffects.importMedia(
          context,
          repoPath,
          assets,
          canvas,
          point.x,
          point.y
        )
        return { ids, canvas }
      },
      {
        onReserved: () => {
          prepared = media
            ? typeof media === 'function'
              ? media()
              : Promise.resolve(media)
            : readMedia()
        },
      }
    )
    if (outcome.status === 'cancelled') return
    const { ids, canvas } = unwrapCanvasOutcome(outcome)
    setSelection({
      surface: canvas ? 'canvas' : 'assets',
      ids: ids ?? [],
      edges: [],
      group: null,
    })
    if (!canvas && ids?.length) setReveal({ id: ids[0], folder: null })
  }

  async function importMedia(media: Media | (() => Promise<Media>)) {
    const outcome = await owner.submit(
      {
        kind: 'mutation',
        capability: 'lifecycle',
        board: owner.getSnapshot(),
      },
      async (context) => {
        const assets = await context.prepare(() =>
          typeof media === 'function' ? media() : Promise.resolve(media)
        )
        return canvasEffects.importMedia(context, repoPath, assets, false, 0, 0)
      }
    )
    if (outcome.status === 'cancelled') return
    const ids = unwrapCanvasOutcome(outcome)
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
      const outcome = await owner.submit(
        {
          kind: 'mutation',
          capability: 'relationship',
          board: owner.getSnapshot(),
        },
        (context) =>
          canvasEffects.unlinkSources(context, repoPath, selection.edges)
      )
      if (outcome.status === 'cancelled') return
      unwrapCanvasOutcome(outcome)
    } else return
    setSelection({ ...selection, ids: [], edges: [], group: null })
  }

  function confirmTrash(ids: number[]) {
    if (ids.length) setTrashIds(ids)
  }

  async function finishTrash() {
    if (!trashIds?.length || lifecyclePendingRef.current) return
    lifecyclePendingRef.current = true
    setLifecyclePending(true)
    const operation = await owner.submit(
      {
        kind: 'mutation',
        capability: 'lifecycle',
        board: owner.getSnapshot(),
      },
      async (context) => {
        const results: PromiseSettledResult<void>[] = []
        for (const id of trashIds) {
          const result = await canvasEffects
            .trashImage(context, repoPath, id)
            .then(
              (value) => ({ status: 'fulfilled' as const, value }),
              (reason: unknown) => ({ status: 'rejected' as const, reason })
            )
          context.assertCurrent()
          results.push(result)
        }
        return results
      }
    )
    if (operation.status === 'cancelled') return
    const outcomes = unwrapCanvasOutcome(operation)
    const failures = outcomes.flatMap((outcome, index) =>
      outcome.status === 'rejected'
        ? [{ id: trashIds[index], cause: outcome.reason }]
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
        `${trashIds.length - failures.length} of ${trashIds.length} assets moved to Trash.${details.length ? ` ${details.join('; ')}` : ''} The current state was refreshed.`
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
    const outcome = await owner.submit(
      {
        kind: 'mutation',
        capability: 'lifecycle',
        board: owner.getSnapshot(),
      },
      (context) => {
        if (owner.getMode() !== 'legacy' && purgeOrigin.current !== 'assets')
          return Promise.resolve(false)
        return canvasEffects
          .purgeImages(context, repoPath, purgeIds)
          .then(() => true)
      }
    )
    if (outcome.status === 'cancelled') return
    const purged = unwrapCanvasOutcome(outcome)
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
