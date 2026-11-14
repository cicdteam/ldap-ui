import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../lib/api'
import { parentDN, sameDN, splitDN } from '../../lib/dn'
import { renameLDIF, renameProblem, renameTarget } from '../../lib/entryOps'
import { Input } from '../../ui/Input'
import { useWorkspace } from '../context'
import { ValueEditor } from '../inspector/ValueEditor'
import { afterWrite } from '../queries'
import { Field, WriteDialog } from './WriteDialog'

/** Rename/Move: a new RDN, a new parent, or both, as one modrdn. */
export function RenameDialog({ dn, close }: { dn: string; close: () => void }) {
  const ws = useWorkspace()
  const qc = useQueryClient()
  const [rdn, setRDN] = useState(splitDN(dn)[0] ?? '')
  const [parent, setParent] = useState(parentDN(dn))
  const [keep, setKeep] = useState(false)
  // Sent only for a move: without it the server keeps the parent.
  const newParent = sameDN(parent, parentDN(dn)) ? undefined : parent.trim()
  const problem = renameProblem(dn, rdn, parent, ws.schema)
  const m = useMutation({
    mutationFn: (confirm: string | undefined) =>
      api.renameEntry(ws.conn, {
        confirm,
        dn,
        newRDN: rdn.trim(),
        newParent,
        keepOldRDN: keep || undefined,
      }),
    onSuccess: (res) => {
      afterWrite(qc, ws.conn, dn)
      ws.select(res.dn)
      close()
    },
  })
  // Only an error: a reset while the request runs would end its pending state.
  const clear = () => {
    if (m.isError) m.reset()
  }
  return (
    <WriteDialog
      title="Rename or move"
      target={
        <>
          {dn} <ArrowRight className="inline h-3 w-3" aria-label="to" /> {renameTarget(rdn, parent)}
        </>
      }
      ldif={renameLDIF(dn, rdn.trim(), newParent, !keep)}
      action="Apply"
      ready={problem === ''}
      pending={m.isPending}
      error={m.error}
      onSubmit={(c) => m.mutate(c)}
      close={close}
    >
      <Field label="New RDN">
        <Input
          aria-label="New RDN"
          mono
          data-autofocus
          className="h-7 flex-1"
          value={rdn}
          onChange={(e) => {
            clear()
            setRDN(e.target.value)
          }}
        />
      </Field>
      <Field label="New parent">
        <ValueEditor
          attr="parent"
          label="New parent"
          value={parent}
          kind="dn"
          onCommit={setParent}
          onDraft={(t) => {
            clear()
            setParent(t)
          }}
        />
      </Field>
      {/* AD refuses to keep the old RDN value (53), so it is not offered there. */}
      {!ws.info.activeDirectory && (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={keep}
            onChange={(e) => {
              clear()
              setKeep(e.target.checked)
            }}
          />
          Keep old RDN value as an attribute
        </label>
      )}
      {problem && <p className="text-xs text-muted">{problem}</p>}
    </WriteDialog>
  )
}
