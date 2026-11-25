export function createCanvasLayoutWriteGate() {
  let pending = 0
  function reserve() {
    pending++
    let released = false
    return () => {
      if (released) return
      released = true
      pending--
    }
  }
  function guard(action: () => Promise<void>) {
    const release = reserve()
    return new Promise<void>((resolve) => resolve(action())).finally(release)
  }
  return { guard, isPending: () => pending > 0, reserve }
}
