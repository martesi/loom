export interface Selection {
  surface: 'assets' | 'canvas'
  ids: number[]
  edges: number[]
  group: number | null
}
export const emptySelection: Selection = {
  surface: 'canvas',
  ids: [],
  edges: [],
  group: null,
}

export function sameSelection(a: Selection, b: Selection) {
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

export function selectAsset(
  current: number[],
  id: number,
  ordered: number[],
  anchor: number | null,
  shift: boolean,
  toggle: boolean
) {
  if (shift && anchor !== null && ordered.includes(anchor)) {
    const a = ordered.indexOf(anchor),
      b = ordered.indexOf(id)
    return ordered.slice(Math.min(a, b), Math.max(a, b) + 1)
  }
  if (toggle)
    return current.includes(id)
      ? current.filter((x) => x !== id)
      : [...current, id]
  return [id]
}
