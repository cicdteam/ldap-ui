import * as Popover from '@radix-ui/react-popover'
import { Check, Ellipsis, Pencil, UserPlus } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { stagedHint, stagedUnder } from '../../lib/entryOps'
import { setPrefs, usePrefs } from '../../lib/prefs'
import { isEditableTarget, isKey, keyLabel } from '../../lib/shortcuts'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { CopyButton } from '../../ui/CopyButton'
import { Kbd } from '../../ui/Kbd'
import { useBatch } from '../batch'
import { useWorkspace } from '../context'
import { ADD_TO_GROUP } from '../events'
import { openEntryAction, visibleActions } from './actions'

const menuItem =
  'block w-full rounded-md px-2 py-1 text-left text-sm hover:bg-hover disabled:pointer-events-none disabled:opacity-60'

/**
 * An action's words, which name its button. A narrow card shows only the icon; the words stay
 * for screen readers.
 */
function Words({ children }: { children: ReactNode }) {
  return <span className="@max-[640px]:sr-only">{children}</span>
}

/**
 * The card's actions: Edit, Add to group, Copy DN and More. More holds Raw values, Reload entry
 * and the entry actions with their keys (N, C, I, R or F2, P, Delete or Mod+Backspace). Set password
 * is there only when password is set (see canSetPassword). Rename/Move and Delete wait while the
 * entry or one below it has staged changes; their key then opens the menu to say why. A read-only
 * profile gets Copy DN and More with Raw values and Reload entry only.
 */
export function EntryActions({
  dn,
  password,
  canEdit,
  editing,
  toggleEdit,
  reload,
}: {
  dn: string
  password: boolean
  canEdit: boolean
  editing: boolean
  toggleEdit: () => void
  reload: () => void
}) {
  const ws = useWorkspace()
  const { raw } = usePrefs()
  const hint = stagedHint(stagedUnder(useBatch(ws.conn), dn))
  const [open, setOpen] = useState(false)
  // A picked item opens a dialog; focus going back to the trigger would take it from the dialog.
  const picked = useRef(false)
  const id = useId()
  const actions = canEdit ? visibleActions(password) : []

  // As E: not while typing, not in the tree's or the results' own keys, not in a dialog.
  useEffect(() => {
    if (!canEdit) return
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
  }, [canEdit, hint, password])

  return (
    <>
      {canEdit && (
        <Button
          size="sm"
          aria-pressed={editing}
          title={`${editing ? 'Stop editing: staged changes stay' : 'Edit this entry: values become fields'} (${keyLabel('E')})`}
          className={cn(editing && 'border-accent/55! bg-selected! font-semibold text-accent-text')}
          onClick={toggleEdit}
        >
          <Pencil className="h-3.5 w-3.5" />
          <Words>Edit</Words>
        </Button>
      )}
      {canEdit && (
        <Button
          size="sm"
          title="Add this entry to a group"
          onClick={() => window.dispatchEvent(new Event(ADD_TO_GROUP))}
        >
          <UserPlus className="h-3.5 w-3.5" />
          <Words>Add to group</Words>
        </Button>
      )}
      <CopyButton text={dn} label="Copy DN" title="Copy the DN" size="sm" variant="default">
        <Words>Copy DN</Words>
      </CopyButton>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button
            size="sm"
            title={
              canEdit
                ? 'More: raw values, reload, new child, clone, import LDIF, rename or move, set password, delete'
                : 'More: raw values, reload'
            }
          >
            <Ellipsis className="h-3.5 w-3.5" />
            <Words>More</Words>
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
            className="elevated z-50 w-72 rounded-[10px] border border-border bg-bg p-1"
          >
            <button
              type="button"
              aria-pressed={raw}
              aria-label="Raw values"
              className={menuItem}
              onClick={() => {
                setOpen(false)
                setPrefs({ raw: !raw })
              }}
            >
              <span className="flex items-center gap-2">
                <span className="flex-1">Raw values</span>
                {raw && <Check aria-hidden className="h-3.5 w-3.5 text-accent-text" />}
              </span>
              <span className="block text-xs text-muted">
                Values as stored: no date, SID or flag decoding, binary as its size
              </span>
            </button>
            <button
              type="button"
              className={menuItem}
              onClick={() => {
                setOpen(false)
                reload()
              }}
            >
              Reload entry
            </button>
            {actions.length > 0 && <hr className="my-1 border-border" />}
            {actions.map((a) => {
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
    </>
  )
}
