import { createRouter } from '@tanstack/react-router'
import { canvasRoute } from './routes/canvas-route'
import { indexRoute } from './routes/index-route'
import { rootRoute } from './routes/root'

const routeTree = rootRoute.addChildren([indexRoute, canvasRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
