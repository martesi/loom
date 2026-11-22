import { useEffect, useRef, useState } from 'react'
import type { RepoInfo } from '../../bindings/loom/internal/service'
import { createRepoListRefresh } from './repo-list-refresh'

export function useRepoListRefresh(
  openRequest: number,
  fetchRepos: () => Promise<RepoInfo[] | null>,
  update: (repos: RepoInfo[]) => void
) {
  const [open, setOpen] = useState(false)
  const controllerRef = useRef<ReturnType<typeof createRepoListRefresh> | null>(
    null
  )
  if (controllerRef.current === null) {
    controllerRef.current = createRepoListRefresh(fetchRepos, update)
  }
  const controller = controllerRef.current

  useEffect(() => {
    if (openRequest > 0) setOpen(true)
  }, [openRequest])

  useEffect(() => {
    controller.setOpen(open)
  }, [controller, open])

  useEffect(() => () => controller.dispose(), [controller])

  return { open, setOpen }
}
