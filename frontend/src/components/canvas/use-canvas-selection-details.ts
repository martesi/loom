import { useMemo } from 'react'
import type {
  CanvasData,
  ImageInfo,
} from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'

interface Props {
  data: CanvasData
  selection: Selection
  assetSelectionKey: string
  assetSelectionRecords: { key: string; records: ImageInfo[] }
  selectedIds: number[]
  displayNodes: { selected?: boolean }[]
  selectedCanvasNodeIds: string[]
}

export function useCanvasSelectionDetails({
  data,
  selection,
  assetSelectionKey,
  assetSelectionRecords,
  selectedIds,
  displayNodes,
  selectedCanvasNodeIds,
}: Props) {
  const selectedIdsSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const selectedImageRecords = useMemo(
    () =>
      selection.surface === 'assets'
        ? assetSelectionRecords.key === assetSelectionKey
          ? assetSelectionRecords.records
          : []
        : (data.images ?? []).filter((image) => selectedIdsSet.has(image.id)),
    [
      selection.surface,
      assetSelectionKey,
      assetSelectionRecords,
      data.images,
      selectedIdsSet,
    ]
  )
  const selectedRelationships = useMemo(
    () =>
      (data.relationships ?? []).filter((relationship) =>
        selection.edges.includes(relationship.id)
      ),
    [data.relationships, selection.edges]
  )
  const singleImageRelations = useMemo(
    () =>
      selectedImageRecords.length === 1
        ? (data.relationships ?? []).filter(
            (relationship) =>
              relationship.sourceImageId === selectedImageRecords[0].id ||
              relationship.derivedImageId === selectedImageRecords[0].id
          )
        : [],
    [data.relationships, selectedImageRecords]
  )
  const relationshipActions = selectedRelationships.length
    ? selectedRelationships
    : singleImageRelations
  return {
    selectedImageRecords,
    selectedRelationships,
    relationshipActions,
    canNavigateRelationship: relationshipActions.length > 0,
    canRemoveRelationship: relationshipActions.length === 1,
    canFitSelection: displayNodes.some((node) => node.selected),
    canArrangeSelection: selectedCanvasNodeIds.length > 0,
  }
}
