import { t } from '@lingui/core/macro'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { LibraryService } from '../../../bindings/loom/internal/service'
import type { CanvasAction } from '../../lib/action-catalog'
import {
  readShortcutOverrides,
  shortcutOverridesEvent,
} from '../../lib/shortcut-overrides'
import { canvasAssetActions } from '../../routes/canvas-actions-assets'
import type { CanvasActionsContext } from '../../routes/canvas-actions-context'
import { canvasSelectionActions } from '../../routes/canvas-actions-selection'
import { canvasViewActions } from '../../routes/canvas-actions-view'
import { canvasWorkspaceActions } from '../../routes/canvas-actions-workspace'
import {
  allowsCanvasAction,
  canvasActionCapability,
} from './canvas-mode-policy'
import type { PaletteAsset } from './command-palette'

interface Props {
  context: CanvasActionsContext
  report: (error: unknown) => void
  paletteOpen: boolean
  setPaletteOpen: Dispatch<SetStateAction<boolean>>
  setRecentActionIds: Dispatch<SetStateAction<string[]>>
  pendingRecentAction: MutableRefObject<string | null>
  trashIds: number[] | null
  purgeIds: number[] | null
  host: MutableRefObject<HTMLDivElement | null>
  paletteAssetRequest: number
  setPaletteAssets: Dispatch<SetStateAction<PaletteAsset[]>>
  setPaletteAssetsLoading: Dispatch<SetStateAction<boolean>>
  setPaletteAssetsError: Dispatch<SetStateAction<boolean>>
}

export function useCanvasActionSystem({
  context,
  report,
  paletteOpen,
  setPaletteOpen,
  setRecentActionIds,
  pendingRecentAction,
  trashIds,
  purgeIds,
  host,
  paletteAssetRequest,
  setPaletteAssets,
  setPaletteAssetsLoading,
  setPaletteAssetsError,
}: Props) {
  const [shortcutOverrides, setShortcutOverrides] = useState(
    readShortcutOverrides
  )
  useEffect(() => {
    const sync = () => setShortcutOverrides(readShortcutOverrides())
    window.addEventListener(shortcutOverridesEvent, sync)
    return () => window.removeEventListener(shortcutOverridesEvent, sync)
  }, [])
  const baseActionCatalog: CanvasAction[] = [
    ...canvasWorkspaceActions(context),
    ...canvasViewActions(context),
    ...canvasSelectionActions(context),
    ...canvasAssetActions(context),
  ]
  const actionCatalog: CanvasAction[] = baseActionCatalog.map((action) => {
    const allowed = allowsCanvasAction(context.owner.getMode(), action.id)
    return {
      ...action,
      shortcut: shortcutOverrides[action.id] ?? action.shortcut,
      enabled: action.enabled && allowed,
      disabledReason: allowed
        ? action.disabledReason
        : t`Available in Edit mode`,
      execute: () => {
        const capability = canvasActionCapability(action.id)
        if (!capability) return action.execute()
        return context.owner.execute(async () => {
          if (context.owner.allows(capability)) await action.execute()
        })
      },
    }
  })
  const defaultShortcuts = Object.fromEntries(
    baseActionCatalog.flatMap((action) =>
      action.shortcut ? [[action.id, action.shortcut] as const] : []
    )
  )
  const actionById = new Map(actionCatalog.map((action) => [action.id, action]))
  const actionRef = useRef(actionCatalog)
  actionRef.current = actionCatalog

  function executeAction(action: CanvasAction) {
    const currentAction = actionRef.current.find(
      (item) => item.id === action.id
    )
    if (
      !currentAction?.enabled ||
      !allowsCanvasAction(context.owner.getMode(), action.id)
    )
      return Promise.resolve()
    return Promise.resolve(currentAction.execute()).catch(report)
  }
  function executeActionById(id: string) {
    const action = actionById.get(id)
    if (action) void executeAction(action)
  }
  const dockActionRef = useRef(executeActionById)
  dockActionRef.current = executeActionById
  const runDockAction = useCallback(
    (id: string) => dockActionRef.current(id),
    []
  )
  const setAssetsOpenAction = useCallback(
    (open: boolean) => runDockAction(open ? 'open-assets' : 'close-assets'),
    [runDockAction]
  )
  const setAssetsPinnedAction = useCallback(
    (pinned: boolean) => runDockAction(pinned ? 'pin-assets' : 'unpin-assets'),
    [runDockAction]
  )
  const setInspectorOpenAction = useCallback(
    (open: boolean) =>
      runDockAction(open ? 'open-inspector' : 'close-inspector'),
    [runDockAction]
  )
  const setInspectorPinnedAction = useCallback(
    (pinned: boolean) =>
      runDockAction(pinned ? 'pin-inspector' : 'unpin-inspector'),
    [runDockAction]
  )
  const markAssetsVisible = useCallback(
    (ids: number[]) => {
      context.visible.current = ids
    },
    [context.visible]
  )
  const compressAssets = useCallback(
    (ids: number[]) => {
      context.selectAssets(ids)
      requestAnimationFrame(() => runDockAction('compress-selection'))
    },
    [context.selectAssets, runDockAction]
  )
  const showCommandsAction = useCallback(
    () => runDockAction('show-commands'),
    [runDockAction]
  )
  const goDetail = useCallback(
    (id: number, folder?: boolean) => void context.go(id, folder).catch(report),
    [context.go, report]
  )

  function runPaletteAction(action: CanvasAction) {
    const currentAction = actionById.get(action.id)
    if (!currentAction?.enabled) return
    // The route owns focus after palette commands; do not race dialog restoration.
    setPaletteOpen(false)
    if (
      currentAction.id === 'open-settings' ||
      currentAction.id === 'open-appearance-settings' ||
      currentAction.id === 'show-shortcuts'
    ) {
      requestAnimationFrame(() => void executeAction(currentAction))
      return
    }
    const isLifecycleAction =
      currentAction.id === 'trash-selection' ||
      currentAction.id === 'trash-canvas-selection' ||
      currentAction.id === 'purge-selection'
    if (isLifecycleAction) pendingRecentAction.current = currentAction.id
    requestAnimationFrame(() => {
      void executeAction(currentAction).then(() => {
        if (!isLifecycleAction)
          setRecentActionIds((ids) =>
            [
              currentAction.id,
              ...ids.filter((id) => id !== currentAction.id),
            ].slice(0, 6)
          )
        if (isLifecycleAction && !trashIds && !purgeIds)
          pendingRecentAction.current = null
        requestAnimationFrame(() => {
          if (
            currentAction.id.includes('assets') ||
            currentAction.id === 'show-folders' ||
            currentAction.id === 'show-all-assets' ||
            currentAction.id === 'focus-asset-search' ||
            currentAction.id === 'find-in-assets' ||
            currentAction.id === 'locate-selection'
          ) {
            document
              .querySelector<HTMLElement>(
                '[aria-label="Assets"][data-visible="true"] input, [aria-label="Assets"][data-visible="true"] button, [aria-label="Assets"][data-visible="true"] [tabindex="0"]'
              )
              ?.focus()
          } else if (currentAction.id.includes('inspector')) {
            document
              .querySelector<HTMLElement>(
                '[aria-label="Inspector"][data-visible="true"] input, [aria-label="Inspector"][data-visible="true"] button, [aria-label="Inspector"][data-visible="true"] [tabindex="0"]'
              )
              ?.focus()
          } else if (
            currentAction.id.includes('trash') ||
            currentAction.id.includes('purge') ||
            currentAction.id.includes('unplace') ||
            currentAction.id.includes('archive') ||
            currentAction.id.includes('create-set')
          ) {
            host.current?.focus()
          }
        })
      }, report)
    })
  }

  function choosePaletteAsset(asset: PaletteAsset) {
    setPaletteOpen(false)
    requestAnimationFrame(() => void context.go(asset.id).catch(report))
  }

  // Retry changes this request token to rerun the repository asset query.
  // biome-ignore lint/correctness/useExhaustiveDependencies: paletteAssetRequest is a retry trigger.
  useEffect(() => {
    if (!paletteOpen) {
      setPaletteAssetsLoading(false)
      return
    }
    let cancelled = false
    setPaletteAssets([])
    setPaletteAssetsLoading(true)
    setPaletteAssetsError(false)
    void LibraryService.ListImages(context.repoPath, {
      search: '',
      placement: '',
      status: 'all',
      tagId: 0,
    })
      .then((rows) => {
        if (cancelled) return
        setPaletteAssets(
          (rows ?? [])
            .filter((row) => !row.trashed)
            .map((row) => ({
              id: row.id,
              fileName: row.fileName,
              filePath: row.filePath,
              tags: row.tags ?? [],
            }))
        )
        setPaletteAssetsLoading(false)
      })
      .catch((reason) => {
        if (cancelled) return
        setPaletteAssetsError(true)
        setPaletteAssetsLoading(false)
        report(reason)
      })
    return () => {
      cancelled = true
    }
  }, [paletteOpen, context.repoPath, paletteAssetRequest])

  return {
    actionCatalog,
    defaultShortcuts,
    actionById,
    actionRef,
    executeAction,
    executeActionById,
    runDockAction,
    setAssetsOpenAction,
    setAssetsPinnedAction,
    setInspectorOpenAction,
    setInspectorPinnedAction,
    markAssetsVisible,
    compressAssets,
    showCommandsAction,
    goDetail,
    runPaletteAction,
    choosePaletteAsset,
  }
}
