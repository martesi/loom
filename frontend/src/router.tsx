import { createRouter } from '@tanstack/react-router'
import { canvasRoute } from './routes/canvas-route'
import { indexRoute } from './routes/index-route'
import { rootRoute } from './routes/root'
import { uiMocksRoute } from './routes/ui-mocks'

const routeTree = rootRoute.addChildren([indexRoute, canvasRoute, uiMocksRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
