import { createRootRoute, Outlet } from '@tanstack/react-router'
import { useEffect } from 'react'
import { SystemService } from '../../bindings/loom/internal/service'
import { Toaster, ToastProvider } from '../components/ui/toast'
import { setCapabilities } from '../lib/capabilities-store'

function Root() {
  // Fetched once per page load and cached in capabilities-store — every
  // route reads it from there rather than re-querying.
  useEffect(() => {
    SystemService.IsServerMode().then((isServerMode) => {
      setCapabilities({ isServerMode })
    })
  }, [])

  return (
    <ToastProvider>
      <Outlet />
      <Toaster />
    </ToastProvider>
  )
}

export const rootRoute = createRootRoute({
  component: Root,
})
