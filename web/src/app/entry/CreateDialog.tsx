import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, isApiError } from '../../lib/api'
import { batches } from '../../lib/batchStore'
import { applied, entryChanges } from '../../lib/changes'
import {
  addAttributes,
  addLDIF,
  canCreate,
  cloneForm,
  formDN,
  formProblems,
  newChildForm,
  type EntryForm,
} from '../../lib/entryOps'
import { attrKey } from '../../lib/schema'
import { ErrorBanner } from '../../ui/Banner'
import { Dialog } from '../../ui/Dialog'
import { Spinner } from '../../ui/Spinner'
import { useWorkspace } from '../context'
import { afterWrite, useEntry } from '../queries'
import { EntryFields } from './EntryFields'
import { WriteDialog } from './WriteDialog'

/** New child under dn, or Clone of dn: one form, filled for a clone from the entry as staged. */
export function CreateDialog({
  mode,
  dn,
  close,
}: {
  mode: 'new' | 'clone'
  dn: string
  close: () => void
}) {
  const ws = useWorkspace()
  const source = useEntry(ws.conn, mode === 'clone' ? dn : '')
  const title = mode === 'clone' ? 'Clone entry' : 'New child entry'
  if (mode === 'clone' && !source.data)
    return (
      <Dialog open onOpenChange={(o) => !o && close()} title={title} wide>
        {source.isError ? <ErrorBanner error={source.error} /> : <Spinner />}
      </Dialog>
    )
  const initial = source.data
    ? cloneForm(applied(source.data, entryChanges(batches.get(ws.conn), dn)), ws.schema)
    : newChildForm(dn, ws.schema)
  return <CreateForm title={title} initial={initial} focusRDN={mode === 'clone'} close={close} />
}

function CreateForm({
  title,
  initial,
  focusRDN,
  close,
}: {
  title: string
  initial: EntryForm
  focusRDN: boolean
  close: () => void
}) {
  const ws = useWorkspace()
  const qc = useQueryClient()
  const [form, setForm] = useState(initial)
  const m = useMutation({
    mutationFn: (confirm: string | undefined) =>
      api.addEntry(ws.conn, { confirm, dn: formDN(form), attributes: addAttributes(form) }),
    onSuccess: (res) => {
      afterWrite(qc, ws.conn)
      ws.select(res.dn)
      close()
    },
  })
  const update = (f: EntryForm) => {
    // Only an error: a reset while the request runs would end its pending state.
    if (m.isError) m.reset()
    setForm(f)
  }
  // A server error about a field of the form shows there, any other in the banner.
  const named = isApiError(m.error) ? (m.error.body.attribute ?? '') : ''
  const atField =
    named !== '' &&
    [form.rdnAttr, ...form.attrs.map((a) => a.name)].some((n) => attrKey(n) === attrKey(named))
  const dn = formDN(form)
  return (
    <WriteDialog
      title={title}
      target={dn}
      ldif={addLDIF(dn, addAttributes(form))}
      action="Create"
      ready={canCreate(form, ws.schema)}
      pending={m.isPending}
      error={atField ? null : m.error}
      onSubmit={(c) => m.mutate(c)}
      close={close}
    >
      <EntryFields
        form={form}
        onChange={update}
        problems={formProblems(form, ws.schema)}
        fieldError={
          atField && isApiError(m.error) ? { attr: named, message: m.error.message } : undefined
        }
        focusRDN={focusRDN}
      />
    </WriteDialog>
  )
}
