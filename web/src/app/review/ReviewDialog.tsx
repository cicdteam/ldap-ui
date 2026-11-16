import { useIsMutating, useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api } from '../../lib/api'
import { batches } from '../../lib/batchStore'
import { dropEntry, toLDIF, type EntryChanges } from '../../lib/changes'
import { afterApply, canApply, errorText, invalidCount } from '../../lib/review'
import type { ApplyRequest } from '../../lib/types'
import { Banner, ErrorBanner } from '../../ui/Banner'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { CopyButton } from '../../ui/CopyButton'
import { COPY_LDIF_HINT } from '../../lib/ldif'
import { LdifView } from '../../ui/LdifView'
import { Dialog } from '../../ui/Dialog'
import { Spinner } from '../../ui/Spinner'
import { applyKey, useBatch, useBatchError } from '../batch'
import { useWorkspace } from '../context'
import { entryKey } from '../queries'

export function ReviewDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { conn } = useWorkspace()
  // An apply in flight owns the batch: the dialog (modal, so nothing else can stage) stays open
  // until its result lands. Read from the cache, so a reopened dialog sees it too.
  const applying = useIsMutating({ mutationKey: applyKey(conn) }) > 0
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o || !applying) onOpenChange(o)
      }}
      title="Review changes"
      wide
    >
      {/* Mounted only while open: entries load per opening. */}
      <Review applying={applying} close={() => onOpenChange(false)} />
    </Dialog>
  )
}

function Review({ applying, close }: { applying: boolean; close: () => void }) {
  const ws = useWorkspace()
  const { conn } = ws
  const qc = useQueryClient()
  const batch = useBatch(conn)

  // Every staged entry is loaded, so validation does not depend on what happens to be cached.
  const entries = useQueries({
    queries: batch.map((ec) => ({
      queryKey: entryKey(conn, ec.dn),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.entry(conn, ec.dn, signal),
    })),
  })
  const loading = entries.some((q) => q.isPending)
  const invalid = invalidCount(
    batch,
    entries.flatMap((q) => q.data ?? []),
    ws.schema,
  )

  const apply = useMutation({
    mutationKey: applyKey(conn),
    mutationFn: (req: ApplyRequest) => api.apply(conn, req),
    onSuccess: (res, req) => {
      // Stored errors describe the latest apply only.
      for (const e of req.entries) batches.setError(conn, e.dn, undefined)
      if (res.failed) batches.setError(conn, res.failed.dn, res.failed.error)
      if (res.applied.length) {
        // Written changes leave undo too: undoing would stage them again.
        batches.reset(conn, afterApply(batches.get(conn), req.entries, res))
        for (const k of ['entry', 'memberof', 'members', 'search', 'children'])
          void qc.invalidateQueries({ queryKey: ['c', conn, k] })
      }
      if (!res.failed) close()
    },
  })

  if (!batch.length) return <p className="text-muted">No changes to review.</p>
  const ready = !loading && !applying && canApply({ batch, invalid })
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) apply.mutate({ entries: batch })
      }}
    >
      {!batches.persisted(conn) && (
        <Banner tone="warn">This batch is too large to survive a reload</Banner>
      )}
      {batch.map((ec) => (
        <EntryBlock key={ec.dn} conn={conn} ec={ec} applying={applying} />
      ))}
      {invalid > 0 && (
        <p className="text-xs text-danger">
          {invalid === 1 ? '1 entry fails' : `${invalid} entries fail`} validation: see the
          inspector.
        </p>
      )}
      {apply.isError && <ErrorBanner error={apply.error} />}
      <div className="flex items-center gap-1">
        <CopyButton text={toLDIF(batch)} label="Copy all LDIF" />
        <Button variant="ghost" disabled={applying} onClick={() => batches.clear(conn)}>
          Discard all
        </Button>
        <span className="ml-auto">{(loading || applying) && <Spinner />}</span>
        <Button type="submit" variant="primary" disabled={!ready}>
          Apply
        </Button>
      </div>
    </form>
  )
}

function EntryBlock({ conn, ec, applying }: { conn: string; ec: EntryChanges; applying: boolean }) {
  const error = useBatchError(conn, ec.dn)
  const ldif = toLDIF([ec])
  const ref = useRef<HTMLElement>(null)
  // The failed entry comes into view when the dialog opens and after an apply fails on it.
  useEffect(() => {
    if (error) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [error])
  return (
    <section
      ref={ref}
      className={cn('space-y-1 rounded-md border p-2', error ? 'border-danger' : 'border-border')}
    >
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 font-mono text-xs break-all">{ec.dn}</span>
        <CopyButton text={ldif} label={`Copy LDIF for ${ec.dn}`} title={COPY_LDIF_HINT} />
        <Button
          size="sm"
          variant="ghost"
          disabled={applying}
          onClick={() => batches.set(conn, dropEntry(batches.get(conn), ec.dn))}
        >
          Discard this entry
        </Button>
      </div>
      {/* The stored error is a plain body, not an ApiError: the same banner ErrorBanner renders. */}
      {error && (
        <Banner tone="danger" detail={error.diagnostic}>
          {errorText(error)}
        </Banner>
      )}
      <LdifView ldif={ldif} className="overflow-x-auto rounded bg-panel p-2 font-mono text-xs" />
    </section>
  )
}
