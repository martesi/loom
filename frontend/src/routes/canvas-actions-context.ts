import type { Node } from '@xyflow/react'
import type { Dispatch, SetStateAction } from 'react'
import type {
  CanvasData,
  ImageInfo,
  RelationshipInfo,
} from '../../bindings/loom/internal/service'
import type { CanvasBoardOwner } from '../components/canvas/canvas-board-owner'
import type {
  CanvasOperationContext,
  CanvasUserIntent,
} from '../components/canvas/canvas-operation'
import type { AssetLayout } from '../lib/asset-views'
import type { Selection } from '../lib/selection'

export interface NavigatorModeRequest {
  mode: 'all' | 'folders'
  layout?: AssetLayout
  densityDelta?: -1 | 1
  request: number
}

export interface RevealRequest {
  id: number
  folder: string | null
}

export interface CanvasActionsContext {
  owner: CanvasBoardOwner
  repoPath: string
  importInput: { current: HTMLInputElement | null }
  openImportPicker: () => void
  assetsOpen: boolean
  assetsPinned: boolean
  openAssets: () => void
  toggleAssets: () => void
  closeAssets: () => void
  setAssetsPinned: Dispatch<SetStateAction<boolean>>
  inspectorOpen: boolean
  inspectorPinned: boolean
  openInspector: () => void
  toggleInspector: () => void
  closeInspector: () => void
  setInspectorPinned: Dispatch<SetStateAction<boolean>>
  toggleFocusMode: () => void
  openSettings: (section?: 'appearance' | 'keyboard') => void
  openPalette: (shortcuts?: boolean, initialQuery?: string) => void
  setRepoOpenRequest: Dispatch<SetStateAction<number>>
  setNavigatorModeRequest: Dispatch<SetStateAction<NavigatorModeRequest | null>>
  setSearchFocusRequest: Dispatch<SetStateAction<number>>
  displayNodes: Node[]
  canFitSelection: boolean
  canArrangeSelection: boolean
  fitAll: (operation: CanvasOperationContext) => Promise<void>
  fitSelection: (operation: CanvasOperationContext) => Promise<void>
  resetZoom: (operation: CanvasOperationContext) => Promise<void>
  zoomBy: (operation: CanvasOperationContext, factor: number) => Promise<void>
  arrange: (
    operation: CanvasOperationContext,
    nodeIds?: string[]
  ) => Promise<void>
  selectedCanvasNodeIds: string[]
  visible: { current: number[] }
  selection: Selection
  selectAssets: (ids: number[]) => void
  setSelection: Dispatch<SetStateAction<Selection>>
  data: CanvasData
  alignHorizontal: (operation: CanvasOperationContext) => Promise<void>
  alignVertical: (operation: CanvasOperationContext) => Promise<void>
  selectedIds: () => number[]
  confirmTrash: (ids: number[]) => void
  remove: (purge: boolean) => Promise<void>
  selectedImageRecords: ImageInfo[]
  handlePreview: (node: Node) => void
  handleLocate: (node: Node) => void
  setReveal: Dispatch<SetStateAction<RevealRequest | null>>
  beginSelectionIntent: () => CanvasUserIntent
  go: (id: number, folder?: boolean, intent?: CanvasUserIntent) => Promise<void>
  requestInspectorCommand: (command: string) => void
  setCompressIds: Dispatch<SetStateAction<number[] | null>>
  setExpanded: Dispatch<SetStateAction<number | null>>
  expanded: number | null
  canNavigateRelationship: boolean
  relationshipActions: RelationshipInfo[]
  canRemoveRelationship: boolean
  paste: () => Promise<unknown>
  undoActions: {
    undo: () => Promise<void>
    redo: () => Promise<void>
  }
}
