import * as Popover from '@radix-ui/react-popover'
import { ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { stagedHint, stagedUnder } from '../../lib/entryOps'
import { isEditableTarget, isKey, keyLabel } from '../../lib/shortcuts'
import { Button } from '../../ui/Button'
import { Kbd } from '../../ui/Kbd'
import { useBatch } from '../batch'
import { useWorkspace } from '../context'
import { openEntryAction, visibleActions } from './actions'

const menuItem =
  'block w-full rounded px-2 py-1 text-left text-sm hover:bg-hover disabled:pointer-events-none disabled:opacity-60'

/**
 * The inspector's Actions menu and its keys (N, C, R or F2, P, Delete or Mod+Backspace). Set
 * password is there only when password is set (see canSetPassword). Rename/Move and Delete wait
 * while the entry or one below it has staged changes; their key then opens the menu to say why.
 */
export function EntryActions({ dn, password }: { dn: string; password: boolean }) {
  const ws = useWorkspace()
  const hint = stagedHint(stagedUnder(useBatch(ws.conn), dn))
  const [open, setOpen] = useState(false)
  // A picked item opens a dialog; focus going back to the trigger would take it from the dialog.
  const picked = useRef(false)
  const id = useId()

  // As E: not while typing, not in the tree's or the results' own keys, not in a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null
      if (isEditableTarget(t) || t?.closest('[role=tree],[role=grid],[role=dialog]')) return
      const a = visibleActions(password).find((x) => x.keys.some((k) => isKey(e, k)))
      if (!a) return
      e.preventDefault()
      if (a.clean && hint) setOpen(true)
      else openEntryAction(a.kind)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hint, password])

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          size="sm"
          variant="ghost"
          title="New child, clone, rename or move, delete, set password"
        >
          Actions <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          aria-label="Entry actions"
          onCloseAutoFocus={(e) => {
            if (picked.current) e.preventDefault()
            picked.current = false
          }}
          className="w-72 rounded-md border border-border bg-bg p-1 shadow-lg"
        >
          {visibleActions(password).map((a) => {
            const why = a.clean ? hint : ''
            const whyId = `${id}-${a.kind}`
            return (
              <button
                key={a.kind}
                type="button"
                aria-label={a.label}
                aria-describedby={why ? whyId : undefined}
                disabled={!!why}
                className={menuItem}
                onClick={() => {
                  picked.current = true
                  setOpen(false)
                  openEntryAction(a.kind)
                }}
              >
                <span className="flex items-center gap-2">
                  <span className="flex-1">{a.label}</span>
                  <Kbd>{keyLabel(a.shortcut)}</Kbd>
                </span>
                {why && (
                  <span id={whyId} className="block text-xs text-muted">
                    {why}
                  </span>
                )}
              </button>
            )
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
