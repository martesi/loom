const queues = new Map<string, Promise<void>>()
const busy = new Map<string, number>()
const owners = new Map<string, Map<object, number>>()

/** Serialize board-changing work across owner instances for the same repository. */
export function enqueueCanvasRepositoryWork<T>(
  repoPath: string,
  owner: object,
  isCurrent: () => boolean,
  action: () => Promise<T>
): Promise<T> {
  const byOwner = owners.get(repoPath) ?? new Map<object, number>()
  byOwner.set(owner, (byOwner.get(owner) ?? 0) + 1)
  owners.set(repoPath, byOwner)
  const previous = queues.get(repoPath) ?? Promise.resolve()
  const result = previous.then(() => {
    if (!isCurrent()) return undefined as T
    busy.set(repoPath, (busy.get(repoPath) ?? 0) + 1)
    return action().finally(() => {
      const remaining = (busy.get(repoPath) ?? 1) - 1
      if (remaining) busy.set(repoPath, remaining)
      else busy.delete(repoPath)
    })
  })
  const settled = result.then(
    () => undefined,
    () => undefined
  )
  queues.set(repoPath, settled)
  void settled.then(() => {
    const count = (byOwner.get(owner) ?? 1) - 1
    if (count) byOwner.set(owner, count)
    else byOwner.delete(owner)
    if (!byOwner.size) owners.delete(repoPath)
    if (queues.get(repoPath) === settled) queues.delete(repoPath)
  })
  return result
}

export function canvasRepositoryBarrier(repoPath: string): Promise<void> {
  return queues.get(repoPath) ?? Promise.resolve()
}

export function isCanvasRepositoryBusy(repoPath: string): boolean {
  return (busy.get(repoPath) ?? 0) > 0 || queues.has(repoPath)
}

export function hasOtherCanvasRepositoryWork(
  repoPath: string,
  owner: object
): boolean {
  const byOwner = owners.get(repoPath)
  return Boolean(
    byOwner &&
      [...byOwner.keys()].some(
        (candidate) =>
          candidate !== owner && Reflect.get(candidate, 'disposed') === true
      )
  )
}

export function hasCanvasRepositoryWork(
  repoPath: string,
  owner: object
): boolean {
  return (owners.get(repoPath)?.get(owner) ?? 0) > 0
}
