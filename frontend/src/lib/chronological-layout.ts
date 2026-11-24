import {
  computeSubgraphLayout,
  type LayoutBox,
  type LayoutNode,
} from './layout'

/** Immutable relationship identity and pairing order; reversal keeps both. */
export interface ChronologicalEdge {
  id: string
  source: string
  target: string
  pairingOrder: number
}

export interface ChronologicalComponent {
  pairingOrder: number
  edgeIds: string[]
  boxes: LayoutBox[]
  /** Opaque cache key; pass the entire projection back unchanged. */
  signature: string
}

/** JSON-serializable output. Coordinates are top-left canvas coordinates. */
export interface ChronologicalProjection {
  components: ChronologicalComponent[]
  staged: LayoutBox[]
}

export interface ChronologicalLayoutInput {
  nodes: readonly LayoutNode[]
  edges: readonly ChronologicalEdge[]
  /** Last view projection, for stable shapes and minimum downward displacement. */
  previous?: ChronologicalProjection
  /** Omit for View; provide canvas coordinates to stage orphans for Edit. */
  stagingCenter?: { x: number; y: number }
}

const GAP = 60
const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const compareEdge = (a: ChronologicalEdge, b: ChronologicalEdge) =>
  a.pairingOrder - b.pairingOrder || compareId(a.id, b.id)

/**
 * Derive chronological, left-to-right DAG components. Each component's boxes
 * are in topological order, choosing the earliest incident pairing and then
 * node ID among nodes whose sources have already been emitted. Components are stacked
 * top-to-bottom; unchanged shapes keep their previous coordinates unless an
 * earlier component needs their space. Empty space after shrinkage is retained.
 * Pass the returned projection as `previous` on the next call, or omit it for
 * a fresh deterministic arrangement. Staging is separate from the graph cache.
 * IDs must be unique, dimensions positive and finite, endpoints present, and
 * relationships acyclic. Invalid input throws instead of dropping graph data.
 */
export function layoutChronologicalGraph(
  input: ChronologicalLayoutInput
): ChronologicalProjection {
  const nodes = validate(input)
  const groups = connectedComponents(nodes, input.edges)
  const previous = input.previous?.components ?? []
  const cache = new Map(
    previous.map((component) => [component.signature, component])
  )
  const previousByNode = new Map<string, ChronologicalComponent>()
  for (const component of previous) {
    for (const box of component.boxes) previousByNode.set(box.id, component)
  }
  const components: ChronologicalComponent[] = []
  let bottom = 0

  for (const group of groups) {
    const signature = JSON.stringify([
      group.nodes.map(({ id, width, height }) => [id, width, height]),
      group.edges.map(({ id, source, target, pairingOrder }) => [
        id,
        source,
        target,
        pairingOrder,
      ]),
    ])
    const cached = cache.get(signature)
    const ancestors = new Set<ChronologicalComponent>()
    for (const node of group.nodes) {
      const ancestor = previousByNode.get(node.id)
      if (ancestor) ancestors.add(ancestor)
    }
    const ancestorBoxes = [...ancestors].flatMap((component) => component.boxes)
    const oldTop = ancestorBoxes.length
      ? Math.min(...ancestorBoxes.map((box) => box.y))
      : bottom
    const oldLeft = ancestorBoxes.length
      ? Math.min(...ancestorBoxes.map((box) => box.x))
      : 0
    const top = Math.max(bottom, oldTop)
    const boxes = cached
      ? translateBoxes(
          cached.boxes,
          0,
          top - Math.min(...cached.boxes.map((box) => box.y))
        )
      : freshBoxes(group.nodes, group.edges, oldLeft, top)
    bottom = Math.max(...boxes.map((box) => box.y + box.height)) + GAP
    components.push({
      pairingOrder: group.edges[0].pairingOrder,
      edgeIds: group.edges.map((edge) => edge.id),
      boxes,
      signature,
    })
  }

  const connected = new Set(
    components.flatMap((component) => component.boxes.map((box) => box.id))
  )
  const orphans = [...nodes.values()]
    .filter((node) => !connected.has(node.id))
    .sort((a, b) => compareId(a.id, b.id))
  const obstacles = components.flatMap((component) => component.boxes)
  const staged = input.stagingCenter
    ? stageOrphans(orphans, obstacles, input.stagingCenter)
    : []
  return { components, staged }
}

function validate(input: ChronologicalLayoutInput): Map<string, LayoutNode> {
  const nodes = new Map<string, LayoutNode>()
  for (const node of input.nodes) {
    if (nodes.has(node.id)) throw new Error(`duplicate node id: ${node.id}`)
    if (
      !Number.isFinite(node.width) ||
      !Number.isFinite(node.height) ||
      node.width <= 0 ||
      node.height <= 0
    ) {
      throw new Error(`invalid size for node: ${node.id}`)
    }
    nodes.set(node.id, node)
  }
  const edgeIds = new Set<string>()
  const outgoing = new Map<string, string[]>()
  const indegree = new Map([...nodes.keys()].map((id) => [id, 0]))
  for (const edge of input.edges) {
    if (edgeIds.has(edge.id)) throw new Error(`duplicate edge id: ${edge.id}`)
    if (!nodes.has(edge.source) || !nodes.has(edge.target))
      throw new Error(`missing endpoint for edge: ${edge.id}`)
    if (!Number.isFinite(edge.pairingOrder))
      throw new Error(`invalid pairing order for edge: ${edge.id}`)
    edgeIds.add(edge.id)
    const targets = outgoing.get(edge.source) ?? []
    targets.push(edge.target)
    outgoing.set(edge.source, targets)
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  }
  const queue = [...indegree]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
  for (let i = 0; i < queue.length; i++) {
    for (const target of outgoing.get(queue[i]) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1
      indegree.set(target, remaining)
      if (remaining === 0) queue.push(target)
    }
  }
  if (queue.length !== nodes.size)
    throw new Error('relationships contain a cycle')
  if (
    input.stagingCenter &&
    (!Number.isFinite(input.stagingCenter.x) ||
      !Number.isFinite(input.stagingCenter.y))
  ) {
    throw new Error('invalid staging center')
  }
  return nodes
}

interface ComponentInput {
  nodes: LayoutNode[]
  edges: ChronologicalEdge[]
}

function connectedComponents(
  nodes: Map<string, LayoutNode>,
  edges: readonly ChronologicalEdge[]
): ComponentInput[] {
  const adjacency = new Map<string, string[]>()
  const incident = new Map<string, ChronologicalEdge[]>()
  for (const edge of [...edges].sort(compareEdge)) {
    for (const [id, neighbor] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ]) {
      const neighbors = adjacency.get(id) ?? []
      neighbors.push(neighbor)
      adjacency.set(id, neighbors)
      const links = incident.get(id) ?? []
      links.push(edge)
      incident.set(id, links)
    }
  }
  const seen = new Set<string>()
  const groups: ComponentInput[] = []
  for (const edge of [...edges].sort(compareEdge)) {
    if (seen.has(edge.source)) continue
    const queue = [edge.source]
    const groupNodes: LayoutNode[] = []
    const groupEdges = new Map<string, ChronologicalEdge>()
    seen.add(edge.source)
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]
      const node = nodes.get(id)
      if (!node) throw new Error(`missing node: ${id}`)
      groupNodes.push(node)
      for (const link of incident.get(id) ?? []) groupEdges.set(link.id, link)
      for (const neighbor of adjacency.get(id) ?? []) {
        if (seen.has(neighbor)) continue
        seen.add(neighbor)
        queue.push(neighbor)
      }
    }
    const compareNode = (a: LayoutNode, b: LayoutNode) => {
      const firstA = incident.get(a.id)?.[0]
      const firstB = incident.get(b.id)?.[0]
      if (!firstA || !firstB) throw new Error('component node has no edge')
      return compareEdge(firstA, firstB) || compareId(a.id, b.id)
    }
    const groupLinks = [...groupEdges.values()].sort(compareEdge)
    groups.push({
      nodes: topologicalNodes(groupNodes, groupLinks, compareNode),
      edges: groupLinks,
    })
  }
  return groups
}

function topologicalNodes(
  nodes: LayoutNode[],
  edges: ChronologicalEdge[],
  compareNode: (a: LayoutNode, b: LayoutNode) => number
): LayoutNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const degree = new Map(nodes.map((node) => [node.id, 0]))
  const targets = new Map<string, string[]>()
  for (const edge of edges) {
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
    const next = targets.get(edge.source) ?? []
    next.push(edge.target)
    targets.set(edge.source, next)
  }
  const ready = nodes
    .filter((node) => degree.get(node.id) === 0)
    .sort(compareNode)
  const sorted: LayoutNode[] = []
  while (ready.length) {
    const node = ready.shift()
    if (!node) break
    sorted.push(node)
    for (const target of targets.get(node.id) ?? []) {
      const remaining = (degree.get(target) ?? 0) - 1
      degree.set(target, remaining)
      const next = byId.get(target)
      if (remaining === 0 && next) ready.push(next)
    }
    ready.sort(compareNode)
  }
  return sorted
}

function freshBoxes(
  nodes: LayoutNode[],
  edges: ChronologicalEdge[],
  left: number,
  top: number
): LayoutBox[] {
  const positions = computeSubgraphLayout(nodes, edges)
  return nodes.map((node) => {
    const position = positions.get(node.id)
    if (!position) throw new Error(`missing position for node: ${node.id}`)
    return {
      id: node.id,
      width: node.width,
      height: node.height,
      x: position.x + left,
      y: position.y + top,
    }
  })
}

function translateBoxes(
  boxes: LayoutBox[],
  dx: number,
  dy: number
): LayoutBox[] {
  return boxes.map((box) => ({ ...box, x: box.x + dx, y: box.y + dy }))
}

function stageOrphans(
  nodes: LayoutNode[],
  obstacles: LayoutBox[],
  center: { x: number; y: number }
): LayoutBox[] {
  if (!nodes.length) return []
  const columns = Math.ceil(Math.sqrt(nodes.length))
  const widths = Array.from({ length: columns }, () => 0)
  const heights = Array.from(
    { length: Math.ceil(nodes.length / columns) },
    () => 0
  )
  nodes.forEach((node, i) => {
    widths[i % columns] = Math.max(widths[i % columns], node.width)
    heights[Math.floor(i / columns)] = Math.max(
      heights[Math.floor(i / columns)],
      node.height
    )
  })
  const offsets = (sizes: number[]) =>
    sizes.map((_, i) =>
      sizes.slice(0, i).reduce((sum, size) => sum + size + GAP, 0)
    )
  const xs = offsets(widths)
  const ys = offsets(heights)
  const width = xs[columns - 1] + widths[columns - 1]
  const height = ys[heights.length - 1] + heights[heights.length - 1]
  const origin = { x: center.x - width / 2, y: center.y - height / 2 }
  const rect = { ...origin, width, height }
  const choices = (['up', 'down', 'left', 'right'] as const).map((direction) =>
    clearObstacles(rect, obstacles, direction)
  )
  choices.sort(
    (a, b) =>
      (a.x - origin.x) ** 2 +
      (a.y - origin.y) ** 2 -
      (b.x - origin.x) ** 2 -
      (b.y - origin.y) ** 2
  )
  const selected = choices[0]
  return nodes.map((node, i) => ({
    id: node.id,
    width: node.width,
    height: node.height,
    x: selected.x + xs[i % columns],
    y: selected.y + ys[Math.floor(i / columns)],
  }))
}

type Rect = { x: number; y: number; width: number; height: number }

function clearObstacles(
  rect: Rect,
  obstacles: LayoutBox[],
  direction: 'up' | 'down' | 'left' | 'right'
): Rect {
  const result = { ...rect }
  // Every move crosses at least one obstacle boundary, so this terminates.
  for (;;) {
    const collisions = obstacles.filter(
      (box) =>
        result.x < box.x + box.width + GAP &&
        result.x + result.width + GAP > box.x &&
        result.y < box.y + box.height + GAP &&
        result.y + result.height + GAP > box.y
    )
    if (!collisions.length) return result
    if (direction === 'up')
      result.y = Math.min(
        ...collisions.map((box) => box.y - result.height - GAP)
      )
    if (direction === 'down')
      result.y = Math.max(...collisions.map((box) => box.y + box.height + GAP))
    if (direction === 'left')
      result.x = Math.min(
        ...collisions.map((box) => box.x - result.width - GAP)
      )
    if (direction === 'right')
      result.x = Math.max(...collisions.map((box) => box.x + box.width + GAP))
  }
}
