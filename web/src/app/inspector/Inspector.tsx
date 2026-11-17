import * as Tabs from '@radix-ui/react-tabs'
import { Download } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { isApiError } from '../../lib/api'
import { fileSafe } from '../../lib/binary'
import { parentDN, rdnDisplay, splitDN } from '../../lib/dn'
import { formatDisplay, statusChips, visible } from '../../lib/display'
import { canSetPassword } from '../../lib/entryOps'
import { COPY_LDIF_HINT, entryToLDIF } from '../../lib/ldif'
import { asText, nameOf } from '../../lib/results'
import { isEditableTarget } from '../../lib/shortcuts'
import { entryKind } from '../../lib/tree'
import type { Entry } from '../../lib/types'
import { Badge } from '../../ui/Badge'
import { Banner, ErrorBanner } from '../../ui/Banner'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { CopyButton } from '../../ui/CopyButton'
import { Input } from '../../ui/Input'
import { LdifView } from '../../ui/LdifView'
import { download } from '../../ui/download'
import { Spinner } from '../../ui/Spinner'
import { Breadcrumbs } from '../Breadcrumbs'
import { useWorkspace } from '../context'
import { EntryActions } from '../entry/EntryActions'
import { ADD_TO_GROUP } from '../events'
import { useEntry } from '../queries'
import { kindIcons } from '../tree/Tree'
import { Attributes } from './Attributes'
import { Depth, Membership } from './Membership'

const tab =
  'flex items-center border-b-2 border-transparent px-2.5 text-xs text-muted hover:text-fg data-[state=active]:border-accent data-[state=active]:font-semibold data-[state=active]:text-fg'

/** How the card shows an entry; it stays as you move from entry to entry. */
interface CardView {
  tab: string
  nested: boolean
  /** The Operational section is open. */
  operational: boolean
  /** The attribute filter's text. */
  filter: string
}

export function Inspector() {
  const ws = useWorkspace()
  const [view, setView] = useState<CardView>({
    tab: 'attributes',
    nested: false,
    operational: false,
    filter: '',
  })
  const patch = useCallback((p: Partial<CardView>) => setView((v) => ({ ...v, ...p })), [])
  return (
    // A container, so a narrow card can drop the words of its secondary actions.
    <div className="@container flex h-full flex-col">
      {ws.dn ? (
        // Keyed by DN so per-entry state (Edit, the add fields) resets; the view above stays.
        <EntryView key={ws.dn} dn={ws.dn} view={view} setView={patch} />
      ) : (
        <p className="p-4 text-muted">Select an entry in the tree, or search above</p>
      )}
    </div>
  )
}

function EntryView({
  dn,
  view,
  setView,
}: {
  dn: string
  view: CardView
  setView: (p: Partial<CardView>) => void
}) {
  const ws = useWorkspace()
  const q = useEntry(ws.conn, dn)
  const first = splitDN(dn)[0]
  const ldif = q.data ? entryToLDIF(q.data) : ''
  const canEdit = !ws.info.readOnly
  const [editing, setEditing] = useState(false)
  // The Member of add field (see Membership): the palette opens it.
  const addingGroup = useState(0)
  const setAddingGroup = addingGroup[1]
  const toggleEdit = useCallback(() => {
    setEditing((e) => !e)
    setView({ tab: 'attributes' })
    setAddingGroup(0)
  }, [setView, setAddingGroup])

  // E toggles edit mode, except where typing or a widget's own keys (the tree's typeahead) own it.
  useEffect(() => {
    if (!canEdit) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null
      if (e.key.toLowerCase() !== 'e' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (isEditableTarget(t)) return
      if (t?.closest('[role=tree],[role=grid],[role=dialog]')) return
      e.preventDefault()
      toggleEdit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canEdit, toggleEdit])

  // Add to group (the card's button, the palette): Edit on, the Membership tab, its add field
  // open and focused.
  useEffect(() => {
    if (!canEdit) return
    const onAdd = () => {
      setEditing(true)
      setView({ tab: 'membership' })
      setAddingGroup((n) => n + 1)
    }
    window.addEventListener(ADD_TO_GROUP, onAdd)
    return () => window.removeEventListener(ADD_TO_GROUP, onAdd)
  }, [canEdit, setView, setAddingGroup])

  return (
    <div className="flex h-full flex-col">
      <CardHeader dn={dn} entry={q.data} busy={q.isFetching}>
        <EntryActions
          dn={dn}
          password={!!q.data && canSetPassword(q.data, ws.schema, ws.info.activeDirectory)}
          canEdit={canEdit}
          editing={editing}
          toggleEdit={toggleEdit}
          reload={() => void q.refetch()}
        />
      </CardHeader>
      {q.isPending && (
        <div className="p-4">
          <Spinner />
        </div>
      )}
      {q.isError && <EntryError dn={dn} error={q.error} retry={() => void q.refetch()} />}
      {q.data && (
        <Tabs.Root
          value={view.tab}
          onValueChange={(t) => setView({ tab: t })}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-border pr-4 pl-2">
            <Tabs.List aria-label="Entry views" className="mr-auto flex self-stretch">
              <Tabs.Trigger value="attributes" className={tab}>
                Attributes
              </Tabs.Trigger>
              <Tabs.Trigger value="membership" className={tab} title="Loads when you open it">
                Membership
              </Tabs.Trigger>
              <Tabs.Trigger value="ldif" className={tab}>
                LDIF
              </Tabs.Trigger>
            </Tabs.List>
            {view.tab === 'attributes' && (
              <Input
                value={view.filter}
                onChange={(e) => setView({ filter: e.target.value })}
                placeholder="Filter attributes and values"
                aria-label="Filter attributes and values"
                className="h-7! w-[230px] shrink text-xs"
              />
            )}
            {view.tab === 'membership' && (
              <Depth nested={view.nested} setNested={(nested) => setView({ nested })} />
            )}
          </div>
          <Tabs.Content value="attributes" className="min-h-0 flex-1 overflow-auto">
            <Attributes
              entry={q.data}
              editing={editing}
              reload={() => void q.refetch()}
              filter={view.filter}
              operational={view.operational}
              setOperational={(operational) => setView({ operational })}
            />
          </Tabs.Content>
          <Tabs.Content value="membership" className="min-h-0 flex-1 overflow-hidden">
            <Membership
              entry={q.data}
              editing={editing}
              nested={view.nested}
              addingGroup={addingGroup}
            />
          </Tabs.Content>
          <Tabs.Content value="ldif" className="min-h-0 flex-1 overflow-auto">
            <div className="flex justify-end gap-1 p-1">
              <CopyButton text={ldif} label="Copy LDIF" title={COPY_LDIF_HINT} />
              <Button
                size="icon"
                variant="ghost"
                aria-label="Download LDIF"
                title="Download the entry as an LDIF file"
                onClick={() => download(`${fileSafe(first ?? 'entry')}.ldif`, ldif, 'text/plain')}
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
            </div>
            <LdifView ldif={ldif} className="px-2 pb-2 font-mono text-xs whitespace-pre" />
          </Tabs.Content>
        </Tabs.Root>
      )}
    </div>
  )
}

/** The first value of the attribute named name (lowercase, no options). */
function firstValue(entry: Entry | undefined, name: string) {
  return entry?.attributes?.find((a) => a.name.toLowerCase() === name)?.values?.[0]
}

/** Up to two initials of a name: John Doe and J. Doe give JD. */
function initials(name: string): string {
  return name
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0])
    .join('')
    .toUpperCase()
}

/**
 * Who the entry is: an avatar (a person's initials, else the icon of its kind), the name (see
 * nameOf) with the RDN, the actions (children), the DN as breadcrumbs, the object classes, the
 * status chips and when it last changed and by whom.
 */
function CardHeader({
  dn,
  entry,
  busy,
  children,
}: {
  dn: string
  entry: Entry | undefined
  busy: boolean
  children: ReactNode
}) {
  const ws = useWorkspace()
  const first = splitDN(dn)[0]
  const name = nameOf(asText(entry ?? { dn }))
  // What nameOf falls back to: then the RDN would only repeat the name.
  const bare = nameOf({ dn, attrs: {} })
  const classes =
    entry?.attributes?.find((a) => a.name.toLowerCase() === 'objectclass')?.values ?? []
  const kind = entryKind(classes.map((c) => c.text))
  const Icon = kindIcons[kind]
  const letters = kind === 'user' ? initials(name) : ''
  const when = firstValue(entry, 'modifytimestamp')
  const by = firstValue(entry, 'modifiersname')
  return (
    <div className="grid shrink-0 grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-[3px] border-b border-border px-4 pt-3 pb-2.5">
      <span
        aria-hidden
        className={cn(
          'row-span-2 grid h-11 w-11 place-items-center rounded-[10px] border',
          letters
            ? 'border-accent/30 bg-selected text-[15px] font-semibold text-accent-text'
            : 'border-border-strong bg-panel text-muted',
        )}
      >
        {letters || <Icon className="h-5 w-5" />}
      </span>
      <div className="flex h-6 min-w-0 items-baseline gap-2">
        {/* Focusable, so closing the list can move focus here (see closeList). */}
        <h2
          id="card-heading"
          tabIndex={-1}
          title={visible(name)}
          className="min-w-0 truncate text-[17px] leading-6 font-semibold"
        >
          {visible(name)}
        </h2>
        {name !== bare && first && (
          <span className="shrink-0 font-mono text-xs text-muted">{rdnDisplay(first)}</span>
        )}
        {busy && <Spinner className="self-center" />}
      </div>
      <div className="col-start-3 row-start-1 flex items-center gap-1.5">{children}</div>
      <div className="col-[2/-1] flex min-w-0 items-center gap-1">
        <Breadcrumbs dn={dn} base={ws.info.baseDN} onSelect={ws.select} />
        <CopyButton text={dn} label="Copy DN from the path" className="h-5! w-5!" />
      </div>
      <div className="col-[2/-1] mt-1 flex min-w-0 flex-wrap items-center gap-1">
        {classes.map((c) => (
          <Badge key={c.text} shape="chip">
            {c.text}
          </Badge>
        ))}
        {entry &&
          statusChips(entry, ws.info).map((c) => (
            <Badge key={c.label} tone={c.tone}>
              {c.label}
            </Badge>
          ))}
        {when && (
          <span
            title={[`modifyTimestamp ${when.text}`, by && `modifiersName ${by.text}`]
              .filter(Boolean)
              .join(', ')}
            className="ml-auto min-w-0 truncate pl-2 text-xs text-muted @max-[640px]:hidden"
          >
            Modified {formatDisplay(when)}
            {by && ` by ${rdnDisplay(splitDN(by.text)[0] ?? by.text)}`}
          </span>
        )}
      </div>
    </div>
  )
}

function EntryError({ dn, error, retry }: { dn: string; error: unknown; retry: () => void }) {
  const ws = useWorkspace()
  if (isApiError(error) && error.code === 'no_such_object') {
    const target = error.body.matchedDN || parentDN(dn)
    return (
      <Banner
        tone="warn"
        action={
          target ? (
            <Button size="sm" onClick={() => ws.select(target)}>
              Open nearest parent
            </Button>
          ) : undefined
        }
      >
        No entry at this DN.
        {target && (
          <span className="block font-mono text-[11px] text-muted">{visible(target)}</span>
        )}
      </Banner>
    )
  }
  return (
    <ErrorBanner
      error={error}
      action={
        <Button size="sm" onClick={retry}>
          Retry
        </Button>
      }
    />
  )
}
