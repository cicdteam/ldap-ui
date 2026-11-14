import { useSyncExternalStore } from 'react'
import { RouterProvider } from 'react-router/dom'
import { authStore } from '../lib/api'
import { router } from './router'
import { UnauthorizedPage } from './UnauthorizedPage'

export function App() {
  const lost = useSyncExternalStore(authStore.subscribe, authStore.get)
  return lost ? <UnauthorizedPage /> : <RouterProvider router={router} />
}
