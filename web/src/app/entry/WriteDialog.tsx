import { useState, type ReactNode } from 'react'
import { ErrorBanner } from '../../ui/Banner'
import { Button } from '../../ui/Button'
import { CopyButton } from '../../ui/CopyButton'
import { LdifView } from '../../ui/LdifView'
import { Dialog } from '../../ui/Dialog'
import { Input } from '../../ui/Input'
import { Spinner } from '../../ui/Spinner'
import { useWorkspace } from '../context'

/**
 * The frame of an entry write: the DN it writes, its fields, its LDIF to read or copy (none for a
 * password, which it would show), the prod confirmation and the action. It stays open while the
 * request runs.
 */
export function WriteDialog({
  title,
  target,
  ldif,
  action,
  danger,
  ready,
  pending,
  error,
  onSubmit,
  close,
  children,
}: {
  title: string
  target: ReactNode
  ldif?: string
  action: string
  danger?: boolean
  ready: boolean
  pending: boolean
  /** Shown as a banner; an error the dialog shows at a field is not passed here. */
  error: unknown
  onSubmit: (confirm: string | undefined) => void
  close: () => void
  children: ReactNode
}) {
  const ws = useWorkspace()
  const prod = ws.info.environment === 'prod'
  const [confirm, setConfirm] = useState('')
  const ok = ready && !pending && (!prod || confirm === ws.conn)
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !pending) close()
      }}
      title={title}
      wide
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (ok) onSubmit(prod ? confirm : undefined)
        }}
      >
        <div className="font-mono text-xs break-all">{target}</div>
        {children}
        {ldif !== undefined && (
          <details>
            <summary className="cursor-pointer text-xs text-muted">LDIF</summary>
            <div className="mt-1 flex items-start gap-1">
              <LdifView
                ldif={ldif}
                className="min-w-0 flex-1 overflow-x-auto rounded bg-panel p-2 font-mono text-xs"
              />
              <CopyButton text={ldif} label="Copy LDIF" />
            </div>
          </details>
        )}
        {error ? <ErrorBanner error={error} /> : null}
        {prod && (
          <label className="flex flex-col gap-1 text-xs">
            Type {ws.conn} to confirm
            <Input
              mono
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}
        <div className="flex items-center justify-end gap-2">
          {pending && <Spinner />}
          <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={!ok}>
            {action}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/** A labelled row of a write dialog; its controls carry their own accessible names. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,11rem)_1fr] items-center gap-2">
      <span className="text-xs text-muted">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-1">{children}</div>
    </div>
  )
}
