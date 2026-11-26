import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssetLayout } from '../../lib/asset-views'
import type { Selection } from '../../lib/selection'
import type { CanvasOperationIntent } from './canvas-board-owner'
import type { PaletteAsset } from './command-palette'
import type { PreviewOrigin } from './use-canvas-preview'

interface NavigatorModeRequest {
  mode: 'all' | 'folders'
  layout?: AssetLayout
  densityDelta?: -1 | 1
  request: number
}

interface InspectorCommandRequest {
  command: string
  request: number
  selectionKey: string
  pending: boolean
}

export interface CanvasMenuState {
  kind: 'pane' | 'node' | 'selection' | 'edge'
  x: number
  y: number
  nodeId?: string
  keyboard?: boolean
}

export type CanvasConnectionTool =
  | 'connect-derivative'
  | 'connect-source'
  | 'reverse-relationship'
  | null

export interface CanvasPendingRelationGesture {
  source: number
  x: number
  y: number
  intent: CanvasOperationIntent
  intentRevision: number
  intentTargetRevision: number
  intentKey: string
}

export interface RevealRequest {
  id: number
  folder: string | null
}

interface RelationshipPreview {
  x1: number
  y1: number
  x2: number
  y2: number
  valid: boolean | null
}

interface DropTarget {
  id: string
  valid: boolean
  kind: 'relationship'
  reason?: string
}

export function useCanvasWorkspaceState(selection: Selection) {
  const rememberFocus = useCallback(
    (target: { current: HTMLElement | null }) => {
      target.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
    },
    []
  )

  const [refresh, setRefresh] = useState(0),
    [error, setError] = useState(''),
    [space, setSpace] = useState(false),
    [ready, setReady] = useState(false)
  const [compressIds, setCompressIds] = useState<number[] | null>(null)
  const [purgeIds, setPurgeIds] = useState<number[] | null>(null)
  const [trashIds, setTrashIds] = useState<number[] | null>(null)
  const [lifecyclePending, setLifecyclePending] = useState(false)
  const lifecyclePendingRef = useRef(false)
  const fieldSubmissionPending = useRef(false)
  const pendingRecentAction = useRef<string | null>(null)
  const [previewImageId, setPreviewImageId] = useState<number | null>(null)
  const [previewOrigin, setPreviewOrigin] = useState<PreviewOrigin | null>(null)
  // Folder order is captured by the navigator when it opens the preview.
  const [previewFolderOrder, setPreviewFolderOrder] = useState<number[] | null>(
    null
  )
  // Preview information-panel visibility persists across close and reopen.
  const [previewInfoOpen, setPreviewInfoOpen] = useState(false)
  const [assetsOpen, setAssetsOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [assetsPinned, setAssetsPinned] = useState(false)
  const [inspectorPinned, setInspectorPinned] = useState(false)
  const [focusCanvas, setFocusCanvas] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // This optional HUD is a manual real-hardware measurement tool.
  const [perfHud, setPerfHud] = useState(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).has('perf')
  )
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (
        event.code !== 'KeyP' ||
        !event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return
      const target = event.target
      const element = target instanceof Element ? target : null
      if (
        element?.closest(
          'input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=dialog]'
        )
      )
        return
      event.preventDefault()
      setPerfHud((visible) => !visible)
    }
    window.addEventListener('keydown', toggle)
    return () => window.removeEventListener('keydown', toggle)
  }, [])
  const [settingsSection, setSettingsSection] = useState<
    'appearance' | 'keyboard' | null
  >(null)
  const [shortcutsOnly, setShortcutsOnly] = useState(false)
  const [paletteInitialQuery, setPaletteInitialQuery] = useState('')
  const [recentActionIds, setRecentActionIds] = useState<string[]>([])
  const [inspectorCommandRequest, setInspectorCommandRequest] =
    useState<InspectorCommandRequest | null>(null)
  const [repoMenuOpen, setRepoMenuOpen] = useState(false)
  const repoMenuRef = useRef<HTMLDivElement>(null)
  // This hand-rolled dropdown needs the same outside-pointer and Escape dismissal as PositionedMenu.
  useEffect(() => {
    if (!repoMenuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (
        !repoMenuRef.current?.contains(
          event.target as unknown as globalThis.Node
        )
      )
        setRepoMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRepoMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [repoMenuOpen])
  const [searchFocusRequest, setSearchFocusRequest] = useState(0)
  const [repoOpenRequest, setRepoOpenRequest] = useState(0)
  const [navigatorModeRequest, setNavigatorModeRequest] =
    useState<NavigatorModeRequest | null>(null)
  const [paletteAssets, setPaletteAssets] = useState<PaletteAsset[]>([])
  const [paletteAssetsLoading, setPaletteAssetsLoading] = useState(false)
  const [paletteAssetsError, setPaletteAssetsError] = useState(false)
  const [paletteAssetRequest, setPaletteAssetRequest] = useState(0)
  const importInput = useRef<HTMLInputElement>(null)
  const assetsReturnFocus = useRef<HTMLElement | null>(null)
  const inspectorReturnFocus = useRef<HTMLElement | null>(null)
  const paletteReturnFocus = useRef<HTMLElement | null>(null)

  const openAssets = useCallback(() => {
    if (!assetsOpen) rememberFocus(assetsReturnFocus)
    setFocusCanvas(false)
    if (window.matchMedia('(max-width: 720px)').matches) setInspectorOpen(false)
    setAssetsOpen(true)
  }, [assetsOpen, rememberFocus])
  const closeAssets = useCallback(
    (restoreFocus = true) => {
      setAssetsOpen(false)
      if (restoreFocus)
        requestAnimationFrame(() => {
          if (!focusCanvas) assetsReturnFocus.current?.focus()
        })
    },
    [focusCanvas]
  )
  function toggleAssets() {
    if (assetsOpen) closeAssets()
    else openAssets()
  }
  function openInspector() {
    if (!inspectorOpen) rememberFocus(inspectorReturnFocus)
    setFocusCanvas(false)
    if (window.matchMedia('(max-width: 720px)').matches) setAssetsOpen(false)
    setInspectorOpen(true)
  }
  function closeInspector(restoreFocus = true) {
    setInspectorOpen(false)
    setInspectorCommandRequest(null)
    if (restoreFocus)
      requestAnimationFrame(() => {
        if (!focusCanvas) inspectorReturnFocus.current?.focus()
      })
  }
  function toggleInspector() {
    if (inspectorOpen) closeInspector()
    else openInspector()
  }
  function requestInspectorCommand(command: string) {
    openInspector()
    setInspectorCommandRequest((current) => ({
      command,
      request: (current?.request ?? 0) + 1,
      selectionKey: `${selection.surface}:${selection.ids.join(',')}:${selection.group ?? ''}`,
      pending: true,
    }))
  }
  const handleInspectorCommandRequest = useCallback((request: number) => {
    setInspectorCommandRequest((current) =>
      current?.request === request ? { ...current, pending: false } : current
    )
  }, [])
  function openPalette(shortcuts = false, initialQuery = '') {
    rememberFocus(paletteReturnFocus)
    setShortcutsOnly(shortcuts)
    setPaletteInitialQuery(initialQuery)
    setPaletteOpen(true)
  }
  function openSettings(section: 'appearance' | 'keyboard' = 'appearance') {
    setSettingsSection(section)
  }
  function changePaletteOpen(open: boolean) {
    setPaletteOpen(open)
    if (!open) requestAnimationFrame(() => paletteReturnFocus.current?.focus())
  }

  const [menu, setMenu] = useState<CanvasMenuState | null>(null)
  const [reveal, setReveal] = useState<RevealRequest | null>(null)
  const visible = useRef<number[]>([])
  const relation = useRef<CanvasPendingRelationGesture | null>(null)
  const pendingDragNode = useRef<import('@xyflow/react').Node | null>(null)
  const dragTargetRaf = useRef(0)
  const zoomRaf = useRef(0)
  const pendingZoom = useRef(0)
  const [relationshipPreview, setRelationshipPreview] =
    useState<RelationshipPreview | null>(null)
  const [target, setTarget] = useState<DropTarget | null>(null)
  const [connectionTool, setConnectionTool] =
    useState<CanvasConnectionTool>(null)
  const [connectionAnchorId, setConnectionAnchorId] = useState<number | null>(
    null
  )
  const targetRef = useRef(target)
  const updateTarget = useCallback((next: DropTarget | null) => {
    const current = targetRef.current
    if (
      current?.id === next?.id &&
      current?.valid === next?.valid &&
      current?.kind === next?.kind &&
      current?.reason === next?.reason
    )
      return
    targetRef.current = next
    setTarget(next)
  }, [])

  return {
    refresh,
    setRefresh,
    error,
    setError,
    space,
    setSpace,
    ready,
    setReady,
    compressIds,
    setCompressIds,
    purgeIds,
    setPurgeIds,
    trashIds,
    setTrashIds,
    lifecyclePending,
    setLifecyclePending,
    lifecyclePendingRef,
    fieldSubmissionPending,
    pendingRecentAction,
    previewImageId,
    setPreviewImageId,
    previewOrigin,
    setPreviewOrigin,
    previewFolderOrder,
    setPreviewFolderOrder,
    previewInfoOpen,
    setPreviewInfoOpen,
    assetsOpen,
    setAssetsOpen,
    inspectorOpen,
    setInspectorOpen,
    assetsPinned,
    setAssetsPinned,
    inspectorPinned,
    setInspectorPinned,
    focusCanvas,
    setFocusCanvas,
    paletteOpen,
    setPaletteOpen,
    perfHud,
    setPerfHud,
    settingsSection,
    setSettingsSection,
    shortcutsOnly,
    setShortcutsOnly,
    paletteInitialQuery,
    setPaletteInitialQuery,
    recentActionIds,
    setRecentActionIds,
    inspectorCommandRequest,
    setInspectorCommandRequest,
    repoMenuOpen,
    setRepoMenuOpen,
    repoMenuRef,
    searchFocusRequest,
    setSearchFocusRequest,
    repoOpenRequest,
    setRepoOpenRequest,
    navigatorModeRequest,
    setNavigatorModeRequest,
    paletteAssets,
    setPaletteAssets,
    paletteAssetsLoading,
    setPaletteAssetsLoading,
    paletteAssetsError,
    setPaletteAssetsError,
    paletteAssetRequest,
    setPaletteAssetRequest,
    importInput,
    assetsReturnFocus,
    inspectorReturnFocus,
    paletteReturnFocus,
    openAssets,
    closeAssets,
    toggleAssets,
    openInspector,
    closeInspector,
    toggleInspector,
    requestInspectorCommand,
    handleInspectorCommandRequest,
    openPalette,
    openSettings,
    changePaletteOpen,
    menu,
    setMenu,
    reveal,
    setReveal,
    visible,
    relation,
    pendingDragNode,
    dragTargetRaf,
    zoomRaf,
    pendingZoom,
    relationshipPreview,
    setRelationshipPreview,
    target,
    updateTarget,
    connectionTool,
    setConnectionTool,
    connectionAnchorId,
    setConnectionAnchorId,
  }
}
