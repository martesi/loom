import type { Node } from '@xyflow/react'
import type { Dispatch, SetStateAction } from 'react'
import type {
  CanvasData,
  ImageInfo,
  RelationshipInfo,
} from '../../bindings/loom/internal/service'
import type { CanvasBoardOwner } from '../components/canvas/canvas-board-owner'
import type { CanvasConnectionTool } from '../components/canvas/use-canvas-workspace-state'
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
  connectionTool: CanvasConnectionTool
  setConnectionTool: Dispatch<SetStateAction<CanvasConnectionTool>>
  connectionAnchorId: number | null
  setConnectionAnchorId: Dispatch<SetStateAction<number | null>>
  repoPath: string
  importInput: { current: HTMLInputElement | null }
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
  reload: () => Promise<void>
  setRepoOpenRequest: Dispatch<SetStateAction<number>>
  setNavigatorModeRequest: Dispatch<SetStateAction<NavigatorModeRequest | null>>
  setSearchFocusRequest: Dispatch<SetStateAction<number>>
  displayNodes: Node[]
  canFitSelection: boolean
  canArrangeSelection: boolean
  fitAll: () => Promise<void>
  fitSelection: () => Promise<void>
  resetZoom: () => Promise<void>
  zoomBy: (factor: number) => Promise<void>
  arrange: (nodeIds?: string[]) => Promise<void>
  selectedCanvasNodeIds: string[]
  visible: { current: number[] }
  selection: Selection
  selectAssets: (ids: number[]) => void
  setSelection: Dispatch<SetStateAction<Selection>>
  data: CanvasData
  alignHorizontal: () => Promise<void>
  alignVertical: () => Promise<void>
  selectedIds: () => number[]
  confirmTrash: (ids: number[]) => void
  remove: (purge: boolean) => Promise<void>
  selectedImageRecords: ImageInfo[]
  handlePreview: (node: Node) => void
  handleLocate: (node: Node) => void
  setReveal: Dispatch<SetStateAction<RevealRequest | null>>
  go: (id: number, folder?: boolean) => Promise<void>
  requestInspectorCommand: (command: string) => void
  setCompressIds: Dispatch<SetStateAction<number[] | null>>
  setExpanded: Dispatch<SetStateAction<number | null>>
  expanded: number | null
  canNavigateRelationship: boolean
  relationshipActions: RelationshipInfo[]
  canRemoveRelationship: boolean
  paste: () => Promise<void>
  undoActions: {
    undo: () => Promise<void>
    redo: () => Promise<void>
  }
}
