import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../lib/api'
import { passwordProblem } from '../../lib/entryOps'
import type { PasswordMethod } from '../../lib/types'
import { Input } from '../../ui/Input'
import { useWorkspace } from '../context'
import { entryKey } from '../queries'
import { Field, WriteDialog } from './WriteDialog'

const METHODS: { method: PasswordMethod; label: string }[] = [
  { method: 'server', label: 'Server policy (Password Modify)' },
  { method: 'ssha', label: 'SSHA' },
]

/**
 * Set password: typed twice and written at once, never staged. The password lives only in this
 * dialog's state, gone when it closes; there is no LDIF, which would show it or its hash.
 */
export function PasswordDialog({ dn, close }: { dn: string; close: () => void }) {
  const ws = useWorkspace()
  const qc = useQueryClient()
  const ad = ws.info.activeDirectory
  const plain = ad && !ws.info.encrypted
  const methods = METHODS.filter((m) => m.method !== 'server' || ws.info.passwordModify)
  const [method, setMethod] = useState(methods[0].method)
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const problem = passwordProblem(password, repeat)
  const m = useMutation({
    // The password reaches the request through this closure, not the mutation's variables. The
    // mutation cache keeps both until gcTime after the dialog lets go: 0 drops them at once.
    gcTime: 0,
    mutationFn: () => api.setPassword(ws.conn, { dn, password, method: ad ? undefined : method }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: entryKey(ws.conn, dn) })
      close()
    },
  })
  // Only an error: a reset while the request runs would end its pending state.
  const clear = () => {
    if (m.isError) m.reset()
  }
  return (
    <WriteDialog
      title="Set password"
      target={dn}
      action="Set"
      ready={!plain && problem === ''}
      pending={m.isPending}
      error={m.error}
      onSubmit={() => m.mutate()}
      close={close}
    >
      {plain ? (
        <p className="text-sm text-danger">
          Active Directory accepts passwords only over an encrypted connection (ldaps:// or
          StartTLS)
        </p>
      ) : (
        <>
          <Field label="New password">
            <Input
              type="password"
              aria-label="New password"
              autoComplete="new-password"
              data-autofocus
              className="h-7 flex-1"
              value={password}
              onChange={(e) => {
                clear()
                setPassword(e.target.value)
              }}
            />
          </Field>
          <Field label="Repeat">
            <Input
              type="password"
              aria-label="Repeat"
              autoComplete="new-password"
              className="h-7 flex-1"
              value={repeat}
              onChange={(e) => {
                clear()
                setRepeat(e.target.value)
              }}
            />
          </Field>
          {!ad && (
            <Field label="Hash">
              <div role="radiogroup" aria-label="Hash" className="flex flex-wrap items-center">
                {methods.map((x) => (
                  <label key={x.method} className="mr-3 flex items-center gap-1 text-xs">
                    <input
                      type="radio"
                      name="method"
                      checked={method === x.method}
                      onChange={() => {
                        clear()
                        setMethod(x.method)
                      }}
                    />
                    {x.label}
                  </label>
                ))}
              </div>
            </Field>
          )}
          {repeat !== '' && problem && <p className="text-xs text-danger">{problem}</p>}
        </>
      )}
    </WriteDialog>
  )
}
