import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactFlowInstance } from '@xyflow/react'
import { createElement, useState } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import type { CanvasBoardOwner } from './canvas-board-owner'
import { useCanvasRepository } from './use-canvas-repository'

afterEach(() => {
  cleanup()
  mock.restore()
})

it('reinitializes the board and restores its saved viewport after recovery', async () => {
  const viewport = { x: -420, y: 180, zoom: 1.25 }
  const data = { images: [], relationships: [], groups: [] }
  const refresh = mock(async () => ({ snapshot: {} as never, data }))
  const executor = {
    refresh,
    subscribe: mock(() => () => {}),
    isActive: mock(() => true),
  } as unknown as CanvasBoardOwner
  const setViewport = mock(async () => true)
  const flow = { setViewport } as unknown as ReactFlowInstance
  const updateZoomCompensation = mock(() => {})
  const selection = {
    surface: 'canvas' as const,
    ids: [],
    edges: [],
    group: null,
  }
  const getViewport = spyOn(ImageService, 'GetViewport').mockResolvedValue(
    viewport as never
  )
  const hook = renderHook(
    () => {
      const [, setRefresh] = useState(0)
      const [, setError] = useState('')
      const [, setRecords] = useState({ key: '', records: [] })
      const [ready, setReady] = useState(false)
      const repository = useCanvasRepository({
        repoPath: '/repo',
        executor,
        flow,
        updateZoomCompensation,
        selection,
        refresh: 0,
        setRefresh,
        setError,
        setReady,
        setAssetSelectionRecords: setRecords,
      })
      return { repository, ready }
    },
    { wrapper: ({ children }) => createElement('div', null, children) }
  )

  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(setViewport).toHaveBeenCalledTimes(1))
  await act(async () => {
    await hook.result.current.repository.initialize()
  })

  expect(refresh).toHaveBeenCalledTimes(2)
  expect(getViewport).toHaveBeenCalledTimes(2)
  expect(setViewport).toHaveBeenLastCalledWith(viewport)
  expect(hook.result.current.ready).toBe(true)
})
