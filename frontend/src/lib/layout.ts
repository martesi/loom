import { type GraphNode, graphConnect, sugiyama } from 'd3-dag'

export interface LayoutEdge {
  source: string
  target: string
}

export interface LayoutNode {
  id: string
  width: number
  height: number
}

export interface LayoutBox extends LayoutNode {
  x: number
  y: number
}

const LAYOUT_GAP: [number, number] = [40, 60]
const ORPHAN_GAP = 60

// computeSubgraphLayout lays out nodeIds (and any edges between them) via
// d3-dag's sugiyama layered algorithm, returning each node's position
// relative to the cluster's own top-left corner (not yet placed on the
// board — see placeCluster for that half). This is the "internal shape"
// step described in the spec's Algorithm Notes.
export function computeSubgraphLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[]
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  if (nodes.length === 0) return positions

  const sizes = new Map(nodes.map((node) => [node.id, node]))
  const idSet = new Set(sizes.keys())
  const connectedIds = new Set<string>()
  const seenPairs = new Set<string>()
  const pairs: [string, string][] = []
  for (const edge of edges) {
    if (!idSet.has(edge.source) || !idSet.has(edge.target)) continue
    const key = `${edge.source}\0${edge.target}`
    if (seenPairs.has(key)) continue
    seenPairs.add(key)
    connectedIds.add(edge.source)
    connectedIds.add(edge.target)
    pairs.push([edge.source, edge.target])
  }

  if (pairs.length > 0) {
    const graph = graphConnect()(pairs)
    const layout = sugiyama()
      .nodeSize((node: GraphNode<string, [string, string]>) => {
        const size = sizes.get(node.data)
        if (!size) throw new Error(`missing layout size for node ${node.data}`)
        // Sugiyama advances layers on y. Swap dimensions here and axes below
        // so source -> derived generations read left-to-right on the canvas.
        return [size.height, size.width]
      })
      .gap(LAYOUT_GAP)
    layout(graph)

    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    const rawPositions = new Map<string, { x: number; y: number }>()
    for (const graphNode of graph.nodes()) {
      const size = sizes.get(graphNode.data)
      if (!size) continue
      const position = {
        x: graphNode.y - size.width / 2,
        y: graphNode.x - size.height / 2,
      }
      rawPositions.set(graphNode.data, position)
      minX = Math.min(minX, position.x)
      minY = Math.min(minY, position.y)
    }
    for (const [id, position] of rawPositions) {
      positions.set(id, { x: position.x - minX, y: position.y - minY })
    }
  }

  const connectedBottom = [...positions].reduce((bottom, [id, position]) => {
    const size = sizes.get(id)
    return size ? Math.max(bottom, position.y + size.height) : bottom
  }, 0)
  const orphanY = positions.size > 0 ? connectedBottom + ORPHAN_GAP : 0
  let orphanX = 0
  for (const node of nodes) {
    if (connectedIds.has(node.id)) continue
    positions.set(node.id, { x: orphanX, y: orphanY })
    orphanX += node.width + LAYOUT_GAP[0]
  }
  return positions
}

// placeCluster offsets a freshly computed cluster shape past the bounding
// box of every already-placed node on the board — a single offset
// calculation, not a packing search, per the spec's v1 placement strategy
// (obstacle-avoiding "fit into interior gaps" is explicitly shelved).
export function placeCluster(
  clusterPositions: Map<string, { x: number; y: number }>,
  existing: LayoutBox[]
): Map<string, { x: number; y: number }> {
  const placed = new Map<string, { x: number; y: number }>()
  const margin = 60

  let offsetX = 0
  let offsetY = 0
  if (existing.length > 0) {
    let minX = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const p of existing) {
      minX = Math.min(minX, p.x)
      maxY = Math.max(maxY, p.y + p.height)
    }
    offsetX = minX
    offsetY = maxY + margin
  }

  for (const [id, pos] of clusterPositions) {
    placed.set(id, { x: pos.x + offsetX, y: pos.y + offsetY })
  }
  return placed
}
