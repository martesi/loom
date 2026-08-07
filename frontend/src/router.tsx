import { createRouter } from '@tanstack/react-router'
import { boardIndexRoute, boardRoute } from './routes/board-route'
import { indexRoute } from './routes/index-route'
import { libraryRoute } from './routes/library-route'
import { rootRoute } from './routes/root'

const routeTree = rootRoute.addChildren([
  indexRoute,
  boardIndexRoute,
  boardRoute,
  libraryRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
