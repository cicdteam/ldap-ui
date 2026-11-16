import { useQuery, useQueryClient } from '@tanstack/react-query'
import { LogOut, PanelLeft, PanelRight } from 'lucide-react'
import { useCallback, useSyncExternalStore, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { api } from '../lib/api'
import { batches } from '../lib/batchStore'
import { invalidBatch, touchedAttributes } from '../lib/changes'
import type { Entry } from '../lib/types'
import { Badge, ColorDot, ProfileBadges } from '../ui/Badge'
import { Button } from '../ui/Button'
import { keyLabel } from '../lib/shortcuts'
import { plural } from '../lib/status'
import { PrefsToggles } from '../ui/PrefsToggles'
import { useBatch } from './batch'
import { useWorkspace } from './context'
import { OPEN_REVIEW } from './events'
import { Omnibox } from './search/Omnibox'

/**
 * Disconnects the workspace's profile and goes back to the connections screen.
 * Unapplied changes are discarded, after a confirm.
 */
export function useDisconnect(): () => Promise<void> {
  const ws = useWorkspace()
  const qc = useQueryClient()
  const navigate = useNavigate()
  return async () => {
    const batch = batches.get(ws.conn)
    if (batch.length) {
      const n = touchedAttributes(batch)
      const what = plural(n, 'unapplied change', 'unapplied changes')
      if (!window.confirm(`Discard ${what} and disconnect?`)) return
    }
    // Undo history goes too: after a reconnect, Mod+Z must not bring back discarded work.
    batches.reset(ws.conn, [])
    await api.disconnect(ws.conn).catch(() => {})
    await qc.invalidateQueries({ queryKey: ['profiles'] })
    // Leave before dropping the cache: a removed query that the still-mounted
    // workspace refetches gets 401 not_connected, which outside /c/ is ignored
    // instead of sending the user to reconnect.
    navigate('/')
    qc.removeQueries({ queryKey: ['c', ws.conn] })
  }
}

/** The staged change count; opens the review. data-invalid when a cached entry fails validation. */
function ReviewBadge() {
  const ws = useWorkspace()
  const qc = useQueryClient()
  const batch = useBatch(ws.conn)
  const subscribe = useCallback((fn: () => void) => qc.getQueryCache().subscribe(fn), [qc])
  // Re-checked on every query cache event, so an entry that loads later is validated too.
  const invalid = useSyncExternalStore(
    subscribe,
    () =>
      batch.length > 0 &&
      invalidBatch(
        batch,
        qc.getQueriesData<Entry>({ queryKey: ['c', ws.conn, 'entry'] }).flatMap(([, e]) => e ?? []),
        ws.schema,
      ),
  )
  if (!batch.length) return null
  const n = touchedAttributes(batch)
  const label = plural(n, 'change', 'changes')
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={`Review ${label}`}
      title={`${invalid ? 'Some changes fail validation. ' : ''}Review the staged changes and apply them (${keyLabel('Mod+S')})`}
      data-invalid={invalid ? '' : undefined}
      onClick={() => window.dispatchEvent(new Event(OPEN_REVIEW))}
    >
      <Badge tone={invalid ? 'danger' : 'warn'}>{label}</Badge>
    </Button>
  )
}

/** extra: slot for the command palette button (Task 13). */
export function Header({ extra }: { extra?: ReactNode }) {
  const ws = useWorkspace()
  const disconnect = useDisconnect()
  // A fixed bind DN is the profile's, not a person's: only userLogin names who signed in.
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api.profiles() })
  const userLogin = profiles.data?.find((p) => p.name === ws.conn)?.userLogin
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-chrome px-2">
      <Link
        to="/"
        title="All connections"
        className="flex shrink-0 items-center gap-1.5 rounded px-1 font-medium hover:bg-hover"
      >
        <ColorDot color={ws.info.color} />
        {ws.conn}
      </Link>
      <span className="flex shrink-0 gap-1 empty:hidden">
        <ProfileBadges profile={ws.info} />
      </span>
      <Omnibox />
      <div className="flex shrink-0 items-center gap-1">
        {userLogin && ws.info.bindDN && (
          <span className="max-w-md truncate px-1 text-xs text-muted" title={ws.info.bindDN}>
            Signed in as <span className="font-mono">{ws.info.bindDN}</span>
          </span>
        )}
        <ReviewBadge />
        {extra}
        <Button
          size="icon"
          variant="ghost"
          aria-label="Toggle tree"
          title="Show or hide the directory tree"
          onClick={ws.toggleTree}
        >
          <PanelLeft className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Toggle inspector"
          title="Show or hide the entry panel"
          onClick={ws.toggleInspector}
        >
          <PanelRight className="h-4 w-4" />
        </Button>
        <PrefsToggles />
        <Button
          size="icon"
          variant="ghost"
          aria-label="Disconnect"
          title="Disconnect and go back to the connections"
          onClick={() => void disconnect()}
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  )
}
