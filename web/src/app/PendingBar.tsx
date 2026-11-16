import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useSyncExternalStore } from 'react'
import { batches } from '../lib/batchStore'
import { invalidBatch, touchedAttributes } from '../lib/changes'
import { keyLabel } from '../lib/shortcuts'
import { pendingText, plural } from '../lib/status'
import type { Entry } from '../lib/types'
import { Button } from '../ui/Button'
import { cn } from '../ui/cn'
import { useBatch } from './batch'
import { useWorkspace } from './context'
import { OPEN_REVIEW } from './events'

/**
 * Shown only while changes are staged: how many, for which connection, with Discard and Review.
 * data-invalid on Review when a cached entry fails validation.
 */
export function PendingBar() {
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
  const discard = () => {
    // As Disconnect asks; Mod+Z still brings the batch back.
    const what = plural(n, 'unapplied change', 'unapplied changes')
    if (window.confirm(`Discard ${what}?`)) batches.clear(ws.conn)
  }
  return (
    <div
      role="status"
      aria-label="Pending changes"
      className="flex h-11 shrink-0 items-center gap-2 border-t border-warn/45 bg-warn/10 pr-2.5 pl-4 whitespace-nowrap"
    >
      <span className={cn('h-2 w-2 shrink-0 rounded-full', invalid ? 'bg-danger' : 'bg-warn')} />
      <span className="font-semibold">{pendingText(n, batch.length, ws.conn)}</span>
      <span className="min-w-0 truncate font-mono text-xs text-muted">{ws.info.url}</span>
      {invalid && <span className="text-xs text-danger">Some changes fail validation</span>}
      <span className="flex-1" />
      <Button variant="ghost" size="sm" title="Drop every staged change" onClick={discard}>
        Discard
      </Button>
      <Button
        variant="primary"
        size="sm"
        title={`Review the LDIF and apply (${keyLabel('Mod+S')})`}
        data-invalid={invalid ? '' : undefined}
        onClick={() => window.dispatchEvent(new Event(OPEN_REVIEW))}
      >
        Review
        <kbd className="rounded border border-accent-fg/45 px-1 font-mono text-[11px] leading-4">
          {keyLabel('Mod+S')}
        </kbd>
      </Button>
    </div>
  )
}
