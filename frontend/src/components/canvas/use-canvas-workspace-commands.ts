import type { Node } from '@xyflow/react'
import type { MutableRefObject } from 'react'
import type {
  CanvasData,
  ImageInfo,
  RepoInfo,
} from '../../../bindings/loom/internal/service'
import { isMacPlatform } from '../../lib/action-catalog'
import type { Selection } from '../../lib/selection'
import type { useUndoActions } from '../../lib/use-undo'
import type { CanvasActionsContext } from '../../routes/canvas-actions-context'
import { createCanvasMenuItems } from './canvas-context-menu-items'
import type { CanvasOperationContext } from './canvas-operation'
import { useCanvasActionSystem } from './use-canvas-action-system'
import type { useCanvasAssetOperations } from './use-canvas-asset-operations'
import type { useCanvasBoardModel } from './use-canvas-board-model'
import { useCanvasKeyboardShortcuts } from './use-canvas-keyboard-shortcuts'
import { useCanvasPreview } from './use-canvas-preview'
import { useCanvasSelectionDetails } from './use-canvas-selection-details'
import type { useCanvasWorkspaceState } from './use-canvas-workspace-state'

interface Props {
  repo: RepoInfo
  host: MutableRefObject<HTMLDivElement | null>
  data: CanvasData
  selection: Selection
  workspaceState: ReturnType<typeof useCanvasWorkspaceState>
  boardModel: ReturnType<typeof useCanvasBoardModel>
  assetOperations: ReturnType<typeof useCanvasAssetOperations>
  report: (error: unknown) => void
  assetSelectionKey: string
  assetSelectionRecords: { key: string; records: ImageInfo[] }
  view: {
    fitAll: (operation: CanvasOperationContext) => Promise<void>
    fitSelection: (operation: CanvasOperationContext) => Promise<void>
    resetZoom: (operation: CanvasOperationContext) => Promise<void>
    zoomBy: (operation: CanvasOperationContext, factor: number) => Promise<void>
    arrange: (
      operation: CanvasOperationContext,
      nodeIds?: string[]
    ) => Promise<void>
    alignHorizontal: (operation: CanvasOperationContext) => Promise<void>
    alignVertical: (operation: CanvasOperationContext) => Promise<void>
    toggleFocusMode: () => void
  }
  selectionActions: {
    selectAssets: (ids: number[]) => void
    setSelection: React.Dispatch<React.SetStateAction<Selection>>
    setExpanded: React.Dispatch<React.SetStateAction<number | null>>
    expanded: number | null
    selectedIds: () => number[]
    handlePreview: (node: Node) => void
    handleLocate: (node: Node) => void
    undoActions: ReturnType<typeof useUndoActions>
  }
}

export function useCanvasWorkspaceCommands(props: Props) {
  const {
    repo,
    host,
    data,
    selection,
    workspaceState,
    boardModel,
    assetOperations,
    report,
    assetSelectionKey,
    assetSelectionRecords,
    view,
    selectionActions,
  } = props
  const { selectedIdsList, displayNodes, selectedCanvasNodeIds } = boardModel
  const selectionDetails = useCanvasSelectionDetails({
    data,
    selection,
    assetSelectionKey,
    assetSelectionRecords,
    selectedIds: selectedIdsList,
    displayNodes,
    selectedCanvasNodeIds,
  })
  const actionContext: CanvasActionsContext = {
    ...workspaceState,
    ...boardModel,
    ...assetOperations,
    ...selectionDetails,
    ...view,
    repoPath: repo.path,
    data,
    selection,
    ...selectionActions,
  }
  const {
    paletteOpen,
    setPaletteOpen,
    setRecentActionIds,
    pendingRecentAction,
    trashIds,
    purgeIds,
    paletteAssetRequest,
    setPaletteAssets,
    setPaletteAssetsLoading,
    setPaletteAssetsError,
  } = workspaceState
  const actionSystem = useCanvasActionSystem({
    context: actionContext,
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
  })
  const { actionRef, executeAction } = actionSystem
  useCanvasKeyboardShortcuts({
    ...workspaceState,
    actionRef,
    executeAction,
    isMac: isMacPlatform(),
    selection,
    selectedIds: selectionActions.selectedIds,
    remove: assetOperations.remove,
    setSelection: selectionActions.setSelection,
    setExpanded: selectionActions.setExpanded,
    expanded: selectionActions.expanded,
  })
  const menuItems = createCanvasMenuItems({
    menu: workspaceState.menu,
    actions: actionSystem.actionById,
    data,
    execute: executeAction,
  })
  const preview = useCanvasPreview({
    data,
    mode: boardModel.mode,
    graphOrder: boardModel.graphOrder,
    repoPath: repo.path,
    previewOrigin: workspaceState.previewOrigin,
    previewFolderOrder: workspaceState.previewFolderOrder,
    previewImageId: workspaceState.previewImageId,
    setPreviewOrigin: workspaceState.setPreviewOrigin,
    setPreviewFolderOrder: workspaceState.setPreviewFolderOrder,
    setPreviewImageId: workspaceState.setPreviewImageId,
  })
  return { ...actionSystem, menuItems, preview }
}
