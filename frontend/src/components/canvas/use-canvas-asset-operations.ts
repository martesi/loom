import type { ReactFlowInstance } from '@xyflow/react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useEffect, useRef } from 'react'
import {
  ImageService,
  SystemService,
} from '../../../bindings/loom/internal/service'
import { readMedia } from '../../lib/clipboard'
import { type Selection, sameSelection } from '../../lib/selection'
import type { CanvasBoardOwner } from './canvas-board-owner'
import type { useCanvasCamera } from './use-canvas-camera'
import type { RevealRequest } from './use-canvas-workspace-state'

interface Props {
  repoPath: string
  owner: CanvasBoardOwner
  flow: ReactFlowInstance
  camera?: ReturnType<typeof useCanvasCamera>
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
  camera,
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
    const cameraVersion = camera?.camera.version()
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
    if (!isCurrent() || (camera && camera.camera.version() !== cameraVersion))
      return
    const zoom = flow.getZoom()
    if (!isCurrent()) return
    const x = node
      ? node.position.x + (node.measured?.width ?? node.width ?? 150) / 2
      : image.canvasX + 75
    const y = node
      ? node.position.y + (node.measured?.height ?? node.height ?? 110) / 2
      : image.canvasY + 55
    if (camera) await camera.center(x, y)
    else await flow.setCenter(x, y, { zoom })
  }

  async function paste(
    media?: Awaited<ReturnType<typeof readMedia>>,
    surface = selection.surface
  ) {
    const point = center()
    const desktopClipboard = !media && !(await SystemService.IsServerMode())
    const { ids, canvas } = await owner.execute(async () => {
      const canvas = surface === 'canvas' && owner.allows('canvas-drop')
      const ids = desktopClipboard
        ? await ImageService.PasteNativeFiles(
            repoPath,
            canvas,
            point.x,
            point.y
          )
        : await ImageService.ImportMedia(
            repoPath,
            media ?? (await readMedia()),
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
    await showImportedAssets(
      await ImageService.ImportMedia(repoPath, media, false, 0, 0)
    )
  }

  async function pickImportFiles(browserPicker: () => void) {
    if (await SystemService.IsServerMode()) {
      browserPicker()
      return
    }
    await showImportedAssets(await ImageService.ImportNativePicker(repoPath))
  }

  async function showImportedAssets(ids: number[] | null) {
    if (!ids?.length) return
    await reload()
    setSelection({ surface: 'assets', ids, edges: [], group: null })
    setReveal({ id: ids[0], folder: null })
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
    const ids = trashIds
    await ImageService.TrashImages(repoPath, ids)
    setTrashIds(null)
    setSelection({ ...selection, ids: [], edges: [], group: null })
    try {
      await reload()
    } catch (cause) {
      console.error('asset trash refresh failed', { cause })
      setError(
        `${ids.length} assets moved to Trash, but the current view could not be refreshed.`
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
    pickImportFiles,
    remove,
    confirmTrash,
    finishTrash,
    confirmPurge,
  }
}
