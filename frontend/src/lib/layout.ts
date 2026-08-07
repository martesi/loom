import { graphConnect, sugiyama } from 'd3-dag'

export interface LayoutEdge {
  source: string
  target: string
}

// Node footprint used for spacing during layout — matches the canvas card
// size (image-node.tsx) plus a little breathing room, not pixel-exact.
const NODE_WIDTH = 190
const NODE_HEIGHT = 170

// computeSubgraphLayout lays out nodeIds (and any edges between them) via
// d3-dag's sugiyama layered algorithm, returning each node's position
// relative to the cluster's own top-left corner (not yet placed on the
// board — see placeCluster for that half). This is the "internal shape"
// step described in the spec's Algorithm Notes.
export function computeSubgraphLayout(
  nodeIds: string[],
  edges: LayoutEdge[]
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  if (nodeIds.length === 0) return positions

  const idSet = new Set(nodeIds)
  const pairs: [string, string][] = edges
    .filter((e) => idSet.has(e.source) && idSet.has(e.target))
    .map((e) => [e.source, e.target])
  // .single(true) lets a [id, id] pair register a node with no edges at
  // all — every node needs a guaranteed entry, edge or not.
  for (const id of nodeIds) pairs.push([id, id])

  const builder = graphConnect().single(true)
  const graph = builder(pairs)
  const layout = sugiyama().nodeSize(() => [NODE_WIDTH, NODE_HEIGHT])
  layout(graph)

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  for (const node of graph.nodes()) {
    minX = Math.min(minX, node.x)
    minY = Math.min(minY, node.y)
  }
  for (const node of graph.nodes()) {
    positions.set(node.data, { x: node.x - minX, y: node.y - minY })
  }
  return positions
}

// placeCluster offsets a freshly computed cluster shape past the bounding
// box of every already-placed node on the board — a single offset
// calculation, not a packing search, per the spec's v1 placement strategy
// (obstacle-avoiding "fit into interior gaps" is explicitly shelved).
export function placeCluster(
  clusterPositions: Map<string, { x: number; y: number }>,
  existingPositions: { x: number; y: number }[]
): Map<string, { x: number; y: number }> {
  const placed = new Map<string, { x: number; y: number }>()
  const margin = 60

  let offsetX = 0
  let offsetY = 0
  if (existingPositions.length > 0) {
    let minX = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const p of existingPositions) {
      minX = Math.min(minX, p.x)
      maxY = Math.max(maxY, p.y + NODE_HEIGHT)
    }
    offsetX = minX
    offsetY = maxY + margin
  }

  for (const [id, pos] of clusterPositions) {
    placed.set(id, { x: pos.x + offsetX, y: pos.y + offsetY })
  }
  return placed
}
