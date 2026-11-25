export function createCanvasLayoutWriteGate() {
  let pending = 0
  const reservations = new Set<() => void>()
  function reserve() {
    pending++
    let released = false
    const release = () => {
      if (released) return
      released = true
      reservations.delete(release)
      pending--
    }
    reservations.add(release)
    return release
  }
  function guard(action: () => Promise<void>) {
    const release = reserve()
    return new Promise<void>((resolve) => resolve(action())).finally(release)
  }
  return {
    guard,
    isPending: () => pending > 0,
    releaseAll: () => {
      for (const release of [...reservations]) release()
    },
    reserve,
  }
}
