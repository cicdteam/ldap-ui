import { isMacPlatform } from '../../lib/shortcuts'
import { ENTRY_ACTION } from '../events'

export type EntryActionKind = 'new' | 'clone' | 'import' | 'rename' | 'password' | 'delete'

export interface EntryAction {
  kind: EntryActionKind
  label: string
  /** The palette's label, by default "<label> entry". */
  palette?: string
  /** The key as keyLabel shows it. */
  shortcut: string
  /** The keys that run it, as isKey matches them. */
  keys: string[]
  /** Waits until nothing is staged for the entry or below it. */
  clean: boolean
}

/** The inspector's entry actions, as the Actions menu, its keys and the palette list them. */
export const ENTRY_ACTIONS: EntryAction[] = [
  { kind: 'new', label: 'New child', shortcut: 'N', keys: ['N'], clean: false },
  { kind: 'clone', label: 'Clone', shortcut: 'C', keys: ['C'], clean: false },
  {
    kind: 'import',
    label: 'Import LDIF here…',
    palette: 'Import LDIF here…',
    shortcut: 'I',
    keys: ['I'],
    clean: false,
  },
  { kind: 'rename', label: 'Rename/Move', shortcut: 'R', keys: ['R', 'F2'], clean: true },
  // Written at once and never staged, so it does not wait for the batch.
  {
    kind: 'password',
    label: 'Set password…',
    palette: 'Set password…',
    shortcut: 'P',
    keys: ['P'],
    clean: false,
  },
  {
    kind: 'delete',
    label: 'Delete',
    // A Mac's delete key is Backspace, so it shows the Finder's Cmd+Backspace; both work anywhere.
    shortcut: isMacPlatform() ? 'Mod+Backspace' : 'Delete',
    keys: ['Delete', 'Mod+Backspace'],
    clean: true,
  },
]

/** Asks the workspace to open kind's dialog for the open entry. */
export function openEntryAction(kind: EntryActionKind): void {
  window.dispatchEvent(new CustomEvent<EntryActionKind>(ENTRY_ACTION, { detail: kind }))
}

/** The actions the open entry offers: Set password only where it can hold one (canSetPassword). */
export function visibleActions(password: boolean): EntryAction[] {
  return ENTRY_ACTIONS.filter((a) => a.kind !== 'password' || password)
}
