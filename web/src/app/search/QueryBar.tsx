import * as Popover from '@radix-ui/react-popover'
import { Crosshair, History, Play, Star, Trash2, X } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { format, fromGroup, parse, serialize, toGroup, type Group } from '../../lib/filter'
import { defaultColumns, parseColumns } from '../../lib/nav'
import { keys, pushHistory, type SavedSearch, type SearchState } from '../../lib/storage'
import type { Scope } from '../../lib/types'
import { keyLabel } from '../../lib/shortcuts'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { Input } from '../../ui/Input'
import { useWorkspace } from '../context'
import { FOCUS_FILTER, FORMAT_FILTER, RUN_SEARCH } from '../events'
import { searchKey } from '../queries'
import { useStored } from '../useStored'
import { FilterEditor, type FilterEditorHandle } from './FilterEditor'
import { FilterBuilder } from './FilterBuilder'

interface Draft {
  filter: string
  base: string
  scope: Scope
  columns: string
}

function toDraft(s: SearchState | null, fallbackColumns: string[]): Draft {
  return {
    filter: s?.filter ?? '',
    base: s?.base ?? '',
    scope: s?.scope ?? 'sub',
    columns: (s?.attrs.length ? s.attrs : fallbackColumns).join(', '),
  }
}

/** The search a draft describes, or the parse error that prevents it. */
function fromDraft(d: Draft): { state: SearchState } | { error: string } {
  let filter = '(objectClass=*)'
  if (d.filter.trim()) {
    const r = parse(d.filter)
    if (!r.ok) return { error: r.error.message }
    filter = serialize(r.filter)
  }
  return { state: { base: d.base.trim(), scope: d.scope, filter, attrs: parseColumns(d.columns) } }
}

const SCOPES: unknown[] = ['base', 'one', 'sub']

/** load() hands back any JSON; only well-formed stored searches are used. */
function isSearch(x: unknown): x is SearchState {
  const s = x as Partial<SearchState> | null
  return (
    typeof s?.filter === 'string' &&
    SCOPES.includes(s.scope) &&
    typeof s.base === 'string' &&
    Array.isArray(s.attrs)
  )
}

export const isSaved = (x: unknown): x is SavedSearch =>
  isSearch(x) && typeof (x as Partial<SavedSearch>).name === 'string'

export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

const menuItem = 'block w-full rounded px-2 py-1 text-left hover:bg-hover'

function SearchLine({ s }: { s: SearchState }) {
  return (
    <>
      <span className="block truncate font-mono text-xs">{s.filter}</span>
      <span className="block truncate text-[11px] text-muted">
        {s.scope} {s.base ? `under ${s.base}` : 'under base DN'}
      </span>
    </>
  )
}

export function QueryBar() {
  const ws = useWorkspace()
  const columns = defaultColumns(ws.info)
  const [draft, setDraft] = useState<Draft>(() => toDraft(ws.search, columns))
  const [mode, setMode] = useState<'text' | 'builder'>('text')
  const [group, setGroup] = useState<Group>({ type: 'and', children: [] })
  const [notice, setNotice] = useState('')
  const [saveName, setSaveName] = useState('')
  const editor = useRef<FilterEditorHandle>(null)
  const [storedHistory, setHistory] = useStored<unknown>(keys.history(ws.conn), [])
  const [storedSaved, setSaved] = useStored<unknown>(keys.saved(ws.conn), [])
  const history = list(storedHistory).filter(isSearch)
  const saved = list(storedSaved).filter(isSaved)

  const current = fromDraft(draft)
  const same = (a: SearchState, b: SearchState) =>
    searchKey(ws.conn, a).join('\0') === searchKey(ws.conn, b).join('\0')

  // A search arriving through the URL (history, palette, tree) replaces the
  // draft; our own run comes back the same way and keeps the text as typed.
  const [synced, setSynced] = useState(ws.search)
  if (ws.search !== synced) {
    setSynced(ws.search)
    if (!(ws.search && 'state' in current && same(ws.search, current.state))) {
      setDraft(toDraft(ws.search, columns))
      setMode('text')
    }
  }

  // Focus after the commit: from the builder the editor mounts first (its
  // view is created in a child effect, which runs before this one).
  const [focusAsk, setFocusAsk] = useState(0)
  useEffect(() => {
    if (focusAsk) editor.current?.focus()
  }, [focusAsk])
  const focusEditor = () => {
    setMode('text')
    setFocusAsk((n) => n + 1)
  }
  const run = (d: Draft = draft) => {
    const r = fromDraft(d)
    if ('error' in r) {
      setNotice(`Fix the filter first: ${r.error}`)
      focusEditor()
      return
    }
    setNotice('')
    setHistory(pushHistory(history, r.state))
    ws.runSearch(r.state)
  }
  const formatFilter = () => {
    // The builder writes formatted text already.
    if (mode !== 'text' || !draft.filter.trim()) return
    const r = parse(draft.filter)
    if (!r.ok) {
      setNotice(`Fix the filter first: ${r.error.message}`)
      focusEditor()
      return
    }
    setNotice('')
    setDraft((d) => ({ ...d, filter: format(r.filter) }))
  }

  // Requests from the command palette and the global "/" key.
  const onFocusFilter = useEffectEvent(focusEditor)
  const onRunSearch = useEffectEvent(() => run())
  const onFormatFilter = useEffectEvent(formatFilter)
  useEffect(() => {
    const handlers: [string, () => void][] = [
      [FOCUS_FILTER, () => onFocusFilter()],
      [RUN_SEARCH, () => onRunSearch()],
      [FORMAT_FILTER, () => onFormatFilter()],
    ]
    for (const [type, fn] of handlers) window.addEventListener(type, fn)
    return () => {
      for (const [type, fn] of handlers) window.removeEventListener(type, fn)
    }
  }, [])

  const switchMode = (m: 'text' | 'builder') => {
    if (m === 'builder') {
      const text = draft.filter.trim()
      if (text) {
        const r = parse(text)
        if (!r.ok) {
          setNotice(`The builder needs a valid filter: ${r.error.message}`)
          return
        }
        setGroup(toGroup(r.filter))
      } else {
        setGroup({ type: 'and', children: [] })
      }
    }
    setNotice('')
    setMode(m)
  }
  const clearFilter = () => {
    setDraft((d) => ({ ...d, filter: '' }))
    setGroup({ type: 'and', children: [] })
    setNotice('')
    if (mode === 'text') setFocusAsk((n) => n + 1)
  }
  const fromBuilder = (g: Group) => {
    setGroup(g)
    setDraft((d) => ({ ...d, filter: g.children.length ? format(fromGroup(g)) : '' }))
  }
  // Stored searches go through the draft, so they run canonical like typed ones.
  const pick = (s: SearchState) => {
    const d = toDraft(s, columns)
    setDraft(d)
    setMode('text')
    run(d)
  }

  return (
    <div className="space-y-[var(--gap)] border-b border-border p-[var(--gap)]">
      <div className="flex items-start gap-2">
        <div
          role="radiogroup"
          aria-label="Filter mode"
          className="flex h-[var(--ctl)] shrink-0 items-center rounded-md border border-border p-0.5 text-xs"
        >
          {(['text', 'builder'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => switchMode(m)}
              className={cn(
                'h-full rounded px-2 capitalize',
                mode === m ? 'bg-selected text-fg' : 'text-muted hover:text-fg',
              )}
            >
              {m}
            </button>
          ))}
        </div>
        {mode === 'text' ? (
          <FilterEditor
            ref={editor}
            value={draft.filter}
            onChange={(filter) => setDraft((d) => ({ ...d, filter }))}
            onRun={run}
            onFormat={formatFilter}
            schema={ws.schema}
          />
        ) : (
          <FilterBuilder group={group} onChange={fromBuilder} attrNames={ws.schema.attrNames} />
        )}
        {draft.filter.trim() && (
          <Button
            size="icon"
            variant="ghost"
            aria-label="Clear filter"
            title="Clear the filter"
            onClick={clearFilter}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          variant="primary"
          onClick={() => run()}
          title={`Run the search (${keyLabel('Mod+Enter')} in the filter)`}
        >
          <Play className="h-3.5 w-3.5" /> Run
        </Button>
      </div>
      {notice && <p className="text-xs text-danger">{notice}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-48 flex-[2] items-center gap-1">
          <span className="text-xs text-muted">Base</span>
          <Input
            mono
            value={draft.base}
            placeholder={ws.info.baseDN}
            onChange={(e) => setDraft((d) => ({ ...d, base: e.target.value }))}
            className="min-w-0 flex-1"
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label="Search under the selected entry"
            title="Use the entry selected in the tree as the search base"
            disabled={!ws.dn}
            onClick={() => setDraft((d) => ({ ...d, base: ws.dn }))}
          >
            <Crosshair className="h-3.5 w-3.5" />
          </Button>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-xs text-muted">Scope</span>
          <select
            value={draft.scope}
            onChange={(e) => setDraft((d) => ({ ...d, scope: e.target.value as Scope }))}
            className="h-[var(--ctl)] rounded-md border border-border bg-bg px-1 text-xs"
          >
            <option value="base">Base entry</option>
            <option value="one">One level</option>
            <option value="sub">Subtree</option>
          </select>
        </label>
        <label className="flex min-w-40 flex-1 items-center gap-1">
          <span className="text-xs text-muted">Columns</span>
          <Input
            mono
            value={draft.columns}
            onChange={(e) => setDraft((d) => ({ ...d, columns: e.target.value }))}
            className="min-w-0 flex-1"
          />
        </label>
        <Popover.Root>
          <Popover.Trigger asChild>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Recent searches"
              title="Recent searches: run one again"
              disabled={!history.length}
            >
              <History className="h-4 w-4" />
            </Button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              className="max-h-80 w-96 overflow-auto rounded-md border border-border bg-bg p-1 shadow-lg"
            >
              {history.map((s, i) => (
                <Popover.Close asChild key={i}>
                  <button type="button" className={menuItem} onClick={() => pick(s)}>
                    <SearchLine s={s} />
                  </button>
                </Popover.Close>
              ))}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <Popover.Root>
          <Popover.Trigger asChild>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Saved searches"
              title="Saved searches: save this one or run one"
            >
              <Star className="h-4 w-4" />
            </Button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              className="max-h-96 w-96 overflow-auto rounded-md border border-border bg-bg p-1 shadow-lg"
            >
              <form
                className="flex gap-1 p-1"
                onSubmit={(e) => {
                  e.preventDefault()
                  const name = saveName.trim()
                  if (!name || 'error' in current) return
                  setSaved([...saved.filter((x) => x.name !== name), { ...current.state, name }])
                  setSaveName('')
                }}
              >
                <Input
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  placeholder="Name this search"
                  className="flex-1"
                />
                <Button type="submit" size="sm" disabled={!saveName.trim() || 'error' in current}>
                  Save
                </Button>
              </form>
              {saved.length === 0 && (
                <p className="px-2 py-1 text-xs text-muted">No saved searches yet.</p>
              )}
              {saved.map((s) => (
                <div key={s.name} className="flex items-center gap-1">
                  <Popover.Close asChild>
                    <button
                      type="button"
                      className={cn(menuItem, 'min-w-0 flex-1')}
                      onClick={() => pick(s)}
                    >
                      <span className="block font-medium">{s.name}</span>
                      <SearchLine s={s} />
                    </button>
                  </Popover.Close>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${s.name}`}
                    onClick={() => setSaved(saved.filter((x) => x.name !== s.name))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
    </div>
  )
}
