import { useSyncExternalStore } from 'react'
import { RouterProvider } from 'react-router/dom'
import { authStore } from '../lib/api'
import { Notice } from './Notice'
import { router } from './router'
import { UnauthorizedPage } from './UnauthorizedPage'

export function App() {
  const lost = useSyncExternalStore(authStore.subscribe, authStore.get)
  // Without the token the API answers nothing, so there is no notice to show.
  if (lost) return <UnauthorizedPage />
  return (
    <div className="flex h-full flex-col">
      <Notice />
      {/* The pages fill this box (h-full): the window less the notice. */}
      <div className="min-h-0 flex-1">
        <RouterProvider router={router} />
      </div>
    </div>
  )
}
