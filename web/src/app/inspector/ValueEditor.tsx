import { useId, useMemo, useState, type KeyboardEvent } from 'react'
import { normDN } from '../../lib/dn'
import { localInputToTime, timeToLocalInput, type EditorKind } from '../../lib/edit'
import { isModKey } from '../../lib/shortcuts'
import { cn } from '../../ui/cn'
import { Input, inputLook } from '../../ui/Input'
import { useWorkspace } from '../context'
import { useDebounced, useFind } from '../queries'

// The look of Input in mono, for the elements Input does not render.
const field = `h-7 min-w-0 flex-1 px-2 font-mono text-xs ${inputLook}`

/**
 * Edits one value as raw text. onCommit gets the new text on blur or Enter
 * (Mod+Enter in a textarea, on change for booleans); '' means cleared.
 * onCancel runs when editing ends without a change. Escape reverts.
 */
export function ValueEditor({
  attr,
  value,
  kind,
  onCommit,
  onCancel,
  onDraft,
  autoFocus,
  label,
  suggest,
  exclude,
}: {
  attr: string
  value: string
  kind: EditorKind
  onCommit: (text: string) => void
  onCancel?: () => void
  /** Every change as typed, converted like onCommit. */
  onDraft?: (text: string) => void
  autoFocus?: boolean
  /** The accessible name, default "<attr> value". */
  label?: string
  /** For a DN: the filter its suggestions come from, by the typed text; default by name, as Cmd+K. */
  suggest?: (text: string) => string
  /** For a DN: DNs never suggested. */
  exclude?: string[]
}) {
  const initial = kind === 'time' ? timeToLocalInput(value) : value
  const [draft, setDraft] = useState(initial)
  const listId = useId()
  const commit = (d: string) => {
    if (d === initial) onCancel?.()
    else onCommit(kind === 'time' ? localInputToTime(d) : d)
  }
  const change = (d: string) => {
    setDraft(d)
    onDraft?.(kind === 'time' ? localInputToTime(d) : d)
  }
  const common = {
    'aria-label': label ?? `${attr} value`,
    value: draft,
    autoFocus,
    onBlur: () => commit(draft),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Escape') {
        setDraft(initial)
        onCancel?.()
      } else if (e.key === 'Enter' && (kind !== 'multiline' || isModKey(e, 'Enter'))) {
        e.preventDefault()
        commit(draft)
      }
    },
  }
  switch (kind) {
    case 'boolean':
      return (
        <select
          {...common}
          className={field}
          onChange={(e) => {
            change(e.target.value)
            commit(e.target.value)
          }}
        >
          {/* '' is the new value's placeholder; an off-syntax value stays visible. */}
          {[...new Set([initial, 'TRUE', 'FALSE'])].map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )
    case 'time':
      return (
        <input
          {...common}
          type="datetime-local"
          step="1"
          className={field}
          onChange={(e) => change(e.target.value)}
        />
      )
    case 'multiline':
      return (
        <textarea
          {...common}
          rows={Math.min(8, draft.split('\n').length)}
          className={cn(field, 'h-auto resize-y py-1')}
          onChange={(e) => change(e.target.value)}
        />
      )
    default:
      return (
        <>
          <Input
            {...common}
            mono
            list={kind === 'dn' ? listId : undefined}
            className="h-7 flex-1"
            onChange={(e) => change(e.target.value)}
          />
          {kind === 'dn' && (
            <DNSuggestions id={listId} text={draft} filter={suggest} exclude={exclude} />
          )}
        </>
      )
  }
}

/**
 * A commit re-renders the row and unmounts the focused control, which drops focus to body. On
 * the next frame focus then goes to attr's row: its "+ value" button, else the row itself.
 */
export function keepFocusIn(attr: string): void {
  requestAnimationFrame(() => {
    if (document.activeElement && document.activeElement !== document.body) return
    const row = document.querySelector<HTMLElement>(`[data-attr="${CSS.escape(attr)}" i]`)
    ;(row?.querySelector<HTMLElement>('[data-add-value]') ?? row)?.focus()
  })
}

/** Up to 8 DNs that filter finds (by name, as Cmd+K, by default) while the text is not a DN yet. */
function DNSuggestions({
  id,
  text,
  filter,
  exclude = [],
}: {
  id: string
  text: string
  filter?: (text: string) => string
  exclude?: string[]
}) {
  const ws = useWorkspace()
  const q = useDebounced(text.trim(), 250)
  const found = useFind(ws.conn, ws.info.baseDN, q, q.length >= 2 && !q.includes('='), filter)
  // Normalized once: a big group excludes thousands of members, and this renders per keystroke.
  const excluded = useMemo(() => new Set(exclude.map(normDN)), [exclude])
  return (
    <datalist id={id}>
      {found.data?.entries
        ?.filter((e) => !excluded.has(normDN(e.dn)))
        .slice(0, 8)
        .map((e) => (
          <option key={e.dn} value={e.dn} />
        ))}
    </datalist>
  )
}
