import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { router } from './app/router'
import { errorKind, retryBusy, routerBasename } from './lib/api'
import { reconnectURL } from './lib/nav'
import { applyPrefs } from './lib/prefs'
import './index.css'

applyPrefs()

// A lost LDAP session (idle expiry, server restart) sends the user to
// reconnect that profile and come back to the same URL.
function onError(err: unknown) {
  if (errorKind(err) !== 'session') return
  const { pathname, search } = router.state.location
  const to = reconnectURL(pathname, search, routerBasename())
  // Replace, so Back from the reconnect screen does not land in the dead workspace.
  if (to) void router.navigate(to, { replace: true })
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  // Writes are never retried: mutations keep TanStack's default of no retry.
  // ponytail: a fixed 1 s delay matches the server's Retry-After: 1; read the header if it varies.
  defaultOptions: {
    queries: { retry: retryBusy, retryDelay: 1000, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
