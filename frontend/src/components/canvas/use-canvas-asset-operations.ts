import type { ReactFlowInstance } from '@xyflow/react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useEffect, useRef } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { readMedia } from '../../lib/clipboard'
import { normalizePayload } from '../../lib/clipboard-payload'
import type { Selection } from '../../lib/selection'
import type { CanvasBoardOwner } from './canvas-board-owner'
import {
  type CanvasUserIntent,
  canvasCancellation,
  unwrapCanvasOutcome,
} from './canvas-operation'
import { canvasEffects } from './canvas-operation-effects'
import type { RevealRequest } from './use-canvas-workspace-state'

type Media = Awaited<ReturnType<typeof readMedia>>

interface Props {
  repoPath: string
  owner: CanvasBoardOwner
  flow: ReactFlowInstance
  selection: Selection
  selectionIntentRevision?: MutableRefObject<number>
  beginSelectionIntent?: () => CanvasUserIntent
  setSelection: Dispatch<SetStateAction<Selection>>
  selectedIds: () => number[]
  setExpanded: Dispatch<SetStateAction<number | null>>
  openAssets: () => void
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

export function useCanvasAssetOperations(props: Props) {
  const {
    repoPath,
    owner,
    flow,
    selection,
    setSelection,
    selectedIds,
    setExpanded,
    openAssets,
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
  } = props
  const purgeOrigin = useRef<Selection['surface'] | null>(null)
  const navigationActive = useRef(true)
  const navigationSequence = useRef(0)
  const fallbackIntentRevision = useRef(0)
  const previousSelection = useRef(selection)
  const internalSelection = useRef<Selection | null>(null)
  if (!sameSelection(previousSelection.current, selection)) {
    if (
      !props.selectionIntentRevision &&
      (!internalSelection.current ||
        !sameSelection(internalSelection.current, selection))
    )
      fallbackIntentRevision.current++
    internalSelection.current = null
    previousSelection.current = selection
  }
  const selectionIntentRevision =
    props.selectionIntentRevision ?? fallbackIntentRevision
  const beginSelectionIntent: () => CanvasUserIntent =
    props.beginSelectionIntent ??
    (() => {
      fallbackIntentRevision.current++
      const ownerIntentRevision = owner.advanceIntent()
      return {
        owner,
        repoPath,
        lifetimeRevision: owner.getLifetimeRevision(),
        modeRevision: owner.getModeRevision(),
        mode: owner.getMode(),
        selectionSurface: selection?.surface ?? 'assets',
        ownerIntentRevision,
        selectionRevision: fallbackIntentRevision.current,
        board: owner.getSnapshot(),
      }
    })
  const currentOwner = useRef({ owner, repoPath })
  currentOwner.current = { owner, repoPath }
  const commitSelection = (next: Selection) => {
    internalSelection.current = next
    setSelection(next)
  }
  useEffect(() => {
    navigationActive.current = true
    return () => {
      navigationActive.current = false
      navigationSequence.current++
    }
  }, [])
  // A retained callback must keep the revision from the render that created it.
  const modeRevision = owner.getModeRevision()
  const isIntentCurrent = (intent: CanvasUserIntent, checkBoard = false) =>
    navigationActive.current &&
    selectionIntentRevision.current === intent.selectionRevision &&
    intent.owner === owner &&
    intent.repoPath === repoPath &&
    intent.lifetimeRevision === owner.getLifetimeRevision() &&
    intent.modeRevision === owner.getModeRevision() &&
    intent.ownerIntentRevision === owner.getIntentRevision() &&
    (!checkBoard || intent.board === owner.getSnapshot()) &&
    currentOwner.current.owner === owner &&
    currentOwner.current.repoPath === repoPath &&
    owner.isActive?.() !== false
  async function go(
    id: number,
    folder = false,
    suppliedIntent?: CanvasUserIntent
  ) {
    if (
      !navigationActive.current ||
      currentOwner.current.owner !== owner ||
      currentOwner.current.repoPath !== repoPath ||
      owner.isActive?.() === false ||
      owner.getModeRevision() !== modeRevision
    )
      return
    const intent = suppliedIntent ?? beginSelectionIntent()
    if (!isIntentCurrent(intent)) return
    const request = ++navigationSequence.current
    const lifetime = intent.lifetimeRevision
    const repository = intent.repoPath
    const isOwnerCurrent = () =>
      navigationActive.current &&
      currentOwner.current.owner === owner &&
      currentOwner.current.repoPath === repository &&
      owner.isActive?.() !== false &&
      owner.getLifetimeRevision() === lifetime &&
      owner.getModeRevision() === intent.modeRevision &&
      selectionIntentRevision.current === intent.selectionRevision &&
      owner.getIntentRevision() === intent.ownerIntentRevision
    if (!isOwnerCurrent()) return
    const isCurrent = () =>
      navigationSequence.current === request && isOwnerCurrent()
    const image = await ImageService.GetImage(repoPath, id)
    if (!isCurrent() || !image) return
    const mode = intent.mode
    const node = mode === 'legacy' ? undefined : flow.getNode(String(id))
    if (!isCurrent()) return
    if (folder || (mode === 'legacy' ? !image.placed : !node)) {
      openAssets()
      if (!isCurrent()) return
      setExpanded(null)
      commitSelection({ surface: 'assets', ids: [id], edges: [], group: null })
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
    commitSelection({ surface: 'canvas', ids: [id], edges: [], group: null })
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
    surface?: Selection['surface'],
    suppliedIntent?: CanvasUserIntent
  ) {
    const intent = suppliedIntent ?? beginSelectionIntent()
    const destinationSurface = surface ?? intent.selectionSurface
    const point = center()
    const board = intent.board
    const shouldPlace =
      destinationSurface === 'canvas' && intent.mode !== 'view'
    const source = media
      ? typeof media === 'function'
        ? media()
        : Promise.resolve(media)
      : readMedia()
    const preparation = await source.then(
      (assets) => ({
        status: 'success' as const,
        assets: validateMedia(assets),
      }),
      (error: unknown) => ({ status: 'failed' as const, error })
    )
    if (preparation.status === 'failed') throw preparation.error
    if (!isIntentCurrent(intent, true))
      return { status: 'cancelled-before-dispatch' as const }
    const outcome = await owner.submit(
      {
        kind: 'mutation',
        capability: 'lifecycle',
        board,
      },
      async (context) => {
        if (!isIntentCurrent(intent, true))
          throw canvasCancellation('Import intent changed before dispatch.')
        const ids = await canvasEffects.importMedia(
          context,
          repoPath,
          preparation.assets,
          shouldPlace,
          point.x,
          point.y
        )
        return { ids, canvas: shouldPlace }
      }
    )
    if (outcome.status === 'cancelled') return
    const { ids, canvas } = unwrapCanvasOutcome(outcome)
    if (!isIntentCurrent(intent)) return
    commitSelection({
      surface: canvas ? 'canvas' : 'assets',
      ids: ids ?? [],
      edges: [],
      group: null,
    })
    if (!canvas && ids?.length) setReveal({ id: ids[0], folder: null })
  }

  async function importMedia(
    media: Media | (() => Promise<Media>),
    suppliedIntent?: CanvasUserIntent
  ) {
    const intent = suppliedIntent ?? beginSelectionIntent()
    const board = intent.board
    const source =
      typeof media === 'function' ? media() : Promise.resolve(media)
    const preparation = await source.then(
      (assets) => ({
        status: 'success' as const,
        assets: validateMedia(assets),
      }),
      (error: unknown) => ({ status: 'failed' as const, error })
    )
    if (preparation.status === 'failed') throw preparation.error
    if (!isIntentCurrent(intent, true))
      return { status: 'cancelled-before-dispatch' as const }
    const outcome = await owner.submit(
      {
        kind: 'mutation',
        capability: 'lifecycle',
        board,
      },
      (context) => {
        if (!isIntentCurrent(intent, true))
          throw canvasCancellation('Import intent changed before dispatch.')
        return canvasEffects.importMedia(
          context,
          repoPath,
          preparation.assets,
          false,
          0,
          0
        )
      }
    )
    if (outcome.status === 'cancelled') return
    const ids = unwrapCanvasOutcome(outcome)
    if (!isIntentCurrent(intent)) return
    commitSelection({
      surface: 'assets',
      ids: ids ?? [],
      edges: [],
      group: null,
    })
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
    commitSelection({ ...selection, ids: [], edges: [], group: null })
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
    commitSelection({ ...selection, ids: [], edges: [], group: null })
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
    commitSelection({ ...selection, ids: [], edges: [], group: null })
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
    beginSelectionIntent,
    paste,
    importMedia,
    remove,
    confirmTrash,
    finishTrash,
    confirmPurge,
  }
}

function validateMedia(media: Media): Media {
  if (!media.length) throw new Error('Clipboard contains no media files')
  return normalizePayload(JSON.stringify({ version: 1, media }))
}

function sameSelection(a: Selection, b: Selection) {
  if (!a || !b) return a === b
  return (
    a.surface === b.surface &&
    a.group === b.group &&
    a.ids.length === b.ids.length &&
    a.edges.length === b.edges.length &&
    a.ids.every((id, index) => id === b.ids[index]) &&
    a.edges.every((id, index) => id === b.edges[index])
  )
}
