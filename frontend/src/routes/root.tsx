import { createRootRoute, Outlet } from '@tanstack/react-router'
import { Toaster, ToastProvider } from '../components/ui/toast'

export const rootRoute = createRootRoute({
  component: () => (
    <ToastProvider>
      <Outlet />
      <Toaster />
    </ToastProvider>
  ),
})
