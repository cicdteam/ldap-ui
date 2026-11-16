import * as Tabs from '@radix-ui/react-tabs'
import { Braces, Download, Pencil, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { isApiError } from '../../lib/api'
import { fileSafe } from '../../lib/binary'
import { parentDN, rdnDisplay, splitDN } from '../../lib/dn'
import { canSetPassword } from '../../lib/entryOps'
import { COPY_LDIF_HINT, entryToLDIF } from '../../lib/ldif'
import { setPrefs, usePrefs } from '../../lib/prefs'
import { isEditableTarget, keyLabel } from '../../lib/shortcuts'
import { Badge } from '../../ui/Badge'
import { Banner, ErrorBanner } from '../../ui/Banner'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { CopyButton } from '../../ui/CopyButton'
import { LdifView } from '../../ui/LdifView'
import { download } from '../../ui/download'
import { PanelHeader } from '../../ui/PanelHeader'
import { Spinner } from '../../ui/Spinner'
import { Breadcrumbs } from '../Breadcrumbs'
import { useWorkspace } from '../context'
import { EntryActions } from '../entry/EntryActions'
import { ADD_TO_GROUP } from '../events'
import { useEntry } from '../queries'
import { Attributes } from './Attributes'
import { Membership } from './Membership'

const tab =
  'h-8 border-b-2 border-transparent px-3 text-xs text-muted hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg'

export function Inspector() {
  const ws = useWorkspace()
  const [view, setView] = useState('attributes')
  return (
    <div className="flex h-full flex-col">
      <PanelHeader>ENTRY</PanelHeader>
      <div className="min-h-0 flex-1">
        {ws.dn ? (
          // Keyed by DN so per-entry state (the attribute filter, edit mode) resets on every entry.
          <EntryView key={ws.dn} dn={ws.dn} view={view} setView={setView} />
        ) : (
          <p className="p-4 text-muted">Select an entry in the tree, or search above</p>
        )}
      </div>
    </div>
  )
}

function EntryView({
  dn,
  view,
  setView,
}: {
  dn: string
  view: string
  setView: (v: string) => void
}) {
  const ws = useWorkspace()
  const { raw } = usePrefs()
  const q = useEntry(ws.conn, dn)
  const first = splitDN(dn)[0]
  const classes =
    q.data?.attributes?.find((a) => a.name.toLowerCase() === 'objectclass')?.values ?? []
  const ldif = q.data ? entryToLDIF(q.data) : ''
  const canEdit = !ws.info.readOnly
  const [editing, setEditing] = useState(false)
  // The Member of add field (see Membership): the palette opens it.
  const addingGroup = useState(0)
  const setAddingGroup = addingGroup[1]
  const toggleEdit = useCallback(() => {
    setEditing((e) => !e)
    setView('attributes')
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

  // The palette's "Add to group…": Edit on, the Membership tab, its add field open and focused.
  useEffect(() => {
    if (!canEdit) return
    const onAdd = () => {
      setEditing(true)
      setView('membership')
      setAddingGroup((n) => n + 1)
    }
    window.addEventListener(ADD_TO_GROUP, onAdd)
    return () => window.removeEventListener(ADD_TO_GROUP, onAdd)
  }, [canEdit, setView, setAddingGroup])

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-1 border-b border-border p-2">
        <div className="flex items-center gap-1">
          {/* Focusable, so closing the list can move focus here (see closeList). */}
          <h2 id="card-heading" tabIndex={-1} className="min-w-0 flex-1 truncate font-semibold">
            {first ? rdnDisplay(first) : dn}
          </h2>
          {q.isFetching && <Spinner />}
          {canEdit && (
            <EntryActions
              dn={dn}
              password={!!q.data && canSetPassword(q.data, ws.schema, ws.info.activeDirectory)}
            />
          )}
          {canEdit && (
            <Button
              size="icon"
              variant="ghost"
              aria-pressed={editing}
              aria-label="Edit"
              title={`${editing ? 'Stop editing' : 'Edit this entry'} (${keyLabel('E')})`}
              className={cn(editing && 'bg-selected text-fg')}
              onClick={toggleEdit}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            aria-pressed={raw}
            aria-label="Raw values"
            title={
              raw
                ? 'Showing values as stored. Click for decoded values'
                : 'Show values as stored: no date, SID or flag decoding, binary as its size'
            }
            className={cn(raw && 'bg-selected text-fg')}
            onClick={() => setPrefs({ raw: !raw })}
          >
            <Braces className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Reload entry"
            title="Reload the entry from the server"
            onClick={() => void q.refetch()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Breadcrumbs dn={dn} base={ws.info.baseDN} onSelect={ws.select} />
          <CopyButton text={dn} label="Copy DN" />
        </div>
        {classes.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {classes.map((c) => (
              <Badge key={c.text} shape="chip">
                {c.text}
              </Badge>
            ))}
          </div>
        )}
      </div>
      {q.isPending && (
        <div className="p-4">
          <Spinner />
        </div>
      )}
      {q.isError && <EntryError dn={dn} error={q.error} retry={() => void q.refetch()} />}
      {q.data && (
        <Tabs.Root value={view} onValueChange={setView} className="flex min-h-0 flex-1 flex-col">
          <Tabs.List aria-label="Entry views" className="flex shrink-0 border-b border-border px-1">
            <Tabs.Trigger value="attributes" className={tab}>
              Attributes
            </Tabs.Trigger>
            <Tabs.Trigger value="membership" className={tab}>
              Membership
            </Tabs.Trigger>
            <Tabs.Trigger value="ldif" className={tab}>
              LDIF
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="attributes" className="min-h-0 flex-1 overflow-auto">
            <Attributes entry={q.data} editing={editing} reload={() => void q.refetch()} />
          </Tabs.Content>
          <Tabs.Content value="membership" className="min-h-0 flex-1 overflow-hidden">
            <Membership entry={q.data} editing={editing} addingGroup={addingGroup} />
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
        {target && <span className="block font-mono text-[11px] text-muted">{target}</span>}
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
