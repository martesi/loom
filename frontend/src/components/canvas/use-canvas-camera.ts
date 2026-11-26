import {
  getNodesBounds,
  getViewportForBounds,
  type Node,
  type ReactFlowInstance,
  type Viewport,
} from '@xyflow/react'
import { useEffect, useMemo, useRef } from 'react'
import { createCanvasCamera } from './canvas-camera'
import {
  registerCameraDrain,
  saveCanvasViewport,
} from './canvas-viewport-store'

export function useCanvasCamera(
  repoPath: string,
  flow: ReactFlowInstance,
  host: { current: HTMLDivElement | null },
  report: (error: unknown) => void
) {
  const current = useRef({ flow, report })
  current.current = { flow, report }
  const gesture = useRef<number | null>(null)
  const pendingLayout = useRef<Promise<Node[]> | null>(null)
  const camera = useMemo(
    () =>
      createCanvasCamera({
        read: () => current.current.flow.getViewport(),
        apply: (viewport) => {
          void current.current.flow
            .setViewport(viewport)
            .catch(current.current.report)
        },
        persist: (viewport) => saveCanvasViewport(repoPath, viewport),
        report: (error) => current.current.report(error),
        clock: {
          now: () => performance.now(),
          request: (callback) => requestAnimationFrame(callback),
          cancel: (id) => cancelAnimationFrame(id),
        },
      }),
    [repoPath]
  )
  useEffect(() => {
    camera.activate()
    return () => {
      camera.dispose()
      registerCameraDrain(repoPath, camera.drain())
    }
  }, [camera, repoPath])

  function fit(nodes: Node[], all = false) {
    const waiting = pendingLayout.current
    if ((!nodes.length && !waiting) || !host.current)
      return Promise.resolve(false)
    const selected = new Set(nodes.map((node) => node.id))
    return camera.move(async () => {
      const layout = waiting ? await waiting : nodes
      const fitted =
        waiting && !all
          ? layout.filter((node) => selected.has(node.id))
          : layout
      if (!fitted.length || !host.current) return flow.getViewport()
      return getViewportForBounds(
        getNodesBounds(fitted),
        host.current.clientWidth,
        host.current.clientHeight,
        0.05,
        4,
        0.2
      )
    }, 250)
  }
  function center(x: number, y: number, duration = 250) {
    return camera.move(async () => {
      const zoom = flow.getViewport().zoom
      return {
        x: (host.current?.clientWidth ?? 0) / 2 - x * zoom,
        y: (host.current?.clientHeight ?? 0) / 2 - y * zoom,
        zoom,
      }
    }, duration)
  }
  function startGesture(event: unknown) {
    if (event) gesture.current = camera.beginGesture()
  }
  function moveGesture(event: unknown, viewport: Viewport) {
    if (event && gesture.current !== null)
      camera.updateGesture(gesture.current, viewport)
  }
  function endGesture(event: unknown, viewport: Viewport) {
    if (!event || gesture.current === null) return
    camera.endGesture(gesture.current, viewport)
    gesture.current = null
  }
  function trackLayout(layout: Promise<Node[]>) {
    pendingLayout.current = layout
    void layout.then(
      () => {
        if (pendingLayout.current === layout) pendingLayout.current = null
      },
      () => {
        if (pendingLayout.current === layout) pendingLayout.current = null
      }
    )
  }
  return {
    camera,
    fit,
    center,
    startGesture,
    moveGesture,
    endGesture,
    trackLayout,
    layoutPending: () => pendingLayout.current !== null,
  }
}
