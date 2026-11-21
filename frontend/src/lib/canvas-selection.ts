import type { Selection } from './selection'

export type NodeSelectionChange = { id: string; selected: boolean }

export function applyCanvasNodeSelection(
  current: Selection,
  changes: NodeSelectionChange[],
  additive: boolean,
  anchor: number[]
): Selection {
  if (!changes.length) return current
  if (!changes.some((change) => change.selected) && current.ids.length === 0 && current.group === null)
    return current

  let ids = current.surface === 'canvas' ? [...current.ids] : []
  let group = current.surface === 'canvas' ? current.group : null
  if (additive) ids = [...new Set([...ids, ...anchor])]

  for (const change of changes) {
    if (change.id.startsWith('set-')) {
      if (change.selected) group = Number(change.id.slice(4))
      else if (!additive) group = null
      continue
    }
    const id = Number(change.id)
    if (change.selected) ids = [...new Set([...ids, id])]
    else if (!additive) ids = ids.filter((selectedId) => selectedId !== id)
  }

  return { surface: 'canvas', ids, edges: [], group }
}
