import { useQueries, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AlertTriangle,
  ChevronRight,
  FileText,
  Folder,
  Globe,
  List,
  RefreshCw,
  User,
  Users,
} from 'lucide-react'
import { useEffect, useEffectEvent, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { api, errorMessage } from '../../lib/api'
import { entryChanges } from '../../lib/changes'
import { ancestorsWithin, isUnder, normDN, sameDN } from '../../lib/dn'
import { defaultColumns } from '../../lib/nav'
import { rowHeight, usePrefs } from '../../lib/prefs'
import { keys, load, save } from '../../lib/storage'
import {
  TREE_PAGE,
  buildRows,
  childrenFromPage,
  visibleExpanded,
  type ChildState,
  type Children,
  type EntryKind,
  type TreeRow,
} from '../../lib/tree'
import { treeKey, type TreeAction } from '../../lib/treeKeys'
import { ChangeDot } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { PanelHeader } from '../../ui/PanelHeader'
import { cn } from '../../ui/cn'
import { useBatch } from '../batch'
import { useWorkspace } from '../context'
import { childrenKey } from '../queries'

const icons: Record<EntryKind, typeof User> = {
  user: User,
  group: Users,
  ou: Folder,
  domain: Globe,
  other: FileText,
}

function RowIcon({ row }: { row: TreeRow }) {
  if (row.type === 'more') return <List className="h-3.5 w-3.5 text-accent" />
  if (row.type === 'error') return <AlertTriangle className="h-3.5 w-3.5 text-danger" />
  if (row.type === 'loading') return null
  const Icon = icons[row.kind]
  return <Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
}

export function Tree() {
  const ws = useWorkspace()
  const qc = useQueryClient()
  const { density } = usePrefs()
  const batch = useBatch(ws.conn)
  const roots = useMemo(() => {
    const seen = new Set<string>()
    return [ws.info.baseDN, ...(ws.info.namingContexts ?? [])]
      .filter((dn) => {
        const k = normDN(dn)
        if (!dn || seen.has(k)) return false
        seen.add(k)
        return true
      })
      .map((dn) => ({ dn, kind: 'domain' as EntryKind }))
  }, [ws.info])

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const saved = load<unknown>(keys.expanded(ws.conn), null)
    // Junk in storage (not a list) must not break the tree.
    if (Array.isArray(saved))
      return new Set(saved.filter((k): k is string => typeof k === 'string'))
    return new Set(roots[0] ? [normDN(roots[0].dn)] : [])
  })
  useEffect(() => {
    save(keys.expanded(ws.conn), [...expanded])
  }, [expanded, ws.conn])

  // Reveal the selected entry: expand its ancestors once per selection.
  const [revealed, setRevealed] = useState('')
  const [focusKey, setFocusKey] = useState<string | null>(null)
  if (ws.dn !== revealed) {
    setRevealed(ws.dn)
    setFocusKey(null)
    const root = roots.find((r) => isUnder(ws.dn, r.dn))
    const anc = root ? ancestorsWithin(ws.dn, root.dn).map(normDN) : []
    if (anc.some((a) => !expanded.has(a))) setExpanded(new Set([...expanded, ...anc]))
  }

  const need = visibleExpanded(roots, expanded, (dn) =>
    qc.getQueryData<Children>(childrenKey(ws.conn, dn)),
  )
  const results = useQueries({
    queries: need.map((dn) => ({
      queryKey: childrenKey(ws.conn, dn),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api
          .search(
            ws.conn,
            {
              base: dn,
              scope: 'one',
              filter: '(objectClass=*)',
              attributes: ['objectClass', 'hasSubordinates', 'numSubordinates'],
              // A size limit, not a page size: a bigger container comes back
              // truncated instead of pinning a server-side cursor nobody reads.
              sizeLimit: TREE_PAGE,
            },
            signal,
          )
          .then(childrenFromPage),
      staleTime: 60_000,
    })),
  })
  const states = new Map<string, ChildState>()
  need.forEach((dn, i) => {
    const r = results[i]
    states.set(
      dn,
      r.isError
        ? { status: 'error', message: errorMessage(r.error) }
        : r.data
          ? { status: 'ok', data: r.data }
          : { status: 'pending' },
    )
  })
  const rows = buildRows(roots, expanded, (dn) => states.get(dn))

  const selectedIndex = ws.dn
    ? rows.findIndex((r) => r.type === 'entry' && sameDN(r.dn, ws.dn))
    : -1
  const keyed = focusKey ? rows.findIndex((r) => r.key === focusKey) : -1
  const focusIndex = keyed >= 0 ? keyed : Math.max(selectedIndex, 0)

  const scrollRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual cannot be memoized; the app does not use the React Compiler, so this is informational only
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight(density),
    overscan: 12,
  })
  useEffect(() => virt.measure(), [density, virt])
  // Scroll only when the focused row changes, not when rows load or expand around it.
  const scrollToFocus = useEffectEvent(() => virt.scrollToIndex(focusIndex, { align: 'auto' }))
  const focusRow = rows[focusIndex]?.key
  useEffect(() => {
    if (focusRow) scrollToFocus()
  }, [focusRow])

  const activate = (r: TreeRow) => {
    if (r.type === 'entry') ws.select(r.dn)
    else if (r.type === 'more')
      ws.runSearch({
        base: r.dn,
        scope: 'one',
        filter: '(objectClass=*)',
        attrs: ws.search?.attrs ?? defaultColumns(ws.info),
      })
    else if (r.type === 'error') void qc.invalidateQueries({ queryKey: childrenKey(ws.conn, r.dn) })
  }
  const toggle = (r: TreeRow) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      const k = normDN(r.dn)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  const apply = (a: TreeAction) => {
    if (a.focus !== undefined) setFocusKey(rows[a.focus].key)
    if (a.expand) setExpanded((prev) => new Set([...prev, ...a.expand!.map(normDN)]))
    if (a.collapse) {
      const k = normDN(a.collapse)
      setExpanded((prev) => new Set([...prev].filter((x) => x !== k)))
    }
    if (a.activate !== undefined) activate(rows[a.activate])
  }

  const typed = useRef('')
  const typedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const printable = e.key.length === 1 && e.key !== ' ' && e.key !== '*'
    const action = treeKey(rows, focusIndex, e.key, printable ? typed.current : '')
    if (printable) {
      typed.current += e.key
      clearTimeout(typedTimer.current)
      typedTimer.current = setTimeout(() => (typed.current = ''), 500)
    }
    if (!action) return
    e.preventDefault()
    apply(action)
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader>
        DIRECTORY
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto"
          aria-label="Refresh tree"
          title="Reload the tree from the server"
          onClick={() => void qc.invalidateQueries({ queryKey: ['c', ws.conn, 'children'] })}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </PanelHeader>
      {/* The focused row draws the ring while the tree has keyboard focus. outline-none
          needs "!" to beat the unlayered global :focus-visible rule in index.css. */}
      <div
        ref={scrollRef}
        role="tree"
        aria-label="Directory tree"
        tabIndex={0}
        aria-activedescendant={rows.length ? `tree-${focusIndex}` : undefined}
        onKeyDown={onKeyDown}
        className="group min-h-0 flex-1 overflow-auto outline-none!"
      >
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((v) => {
            const r = rows[v.index]
            const selected = v.index === selectedIndex
            return (
              <div
                key={r.key}
                id={`tree-${v.index}`}
                role="treeitem"
                aria-level={r.depth + 1}
                aria-expanded={r.expandable ? r.expanded : undefined}
                aria-selected={selected}
                onClick={() => {
                  setFocusKey(r.key)
                  activate(r)
                }}
                style={{
                  height: v.size,
                  transform: `translateY(${v.start}px)`,
                  paddingLeft: r.depth * 14 + 4,
                }}
                className={cn(
                  'absolute top-0 left-0 flex w-full cursor-default items-center gap-1 pr-2 whitespace-nowrap hover:bg-hover',
                  selected && 'bg-selected',
                  v.index === focusIndex &&
                    '-outline-offset-1 outline-accent group-focus-visible:outline-1',
                  r.type === 'more' && 'text-accent',
                  r.type === 'error' && 'text-danger',
                  r.type === 'loading' && 'text-muted',
                )}
              >
                {r.expandable ? (
                  // Not a button: a click must leave focus on the tree (aria-activedescendant).
                  <span
                    aria-hidden
                    onClick={(e) => {
                      e.stopPropagation()
                      toggle(r)
                    }}
                    className="rounded hover:bg-border"
                  >
                    <ChevronRight
                      className={cn('h-3.5 w-3.5 transition-transform', r.expanded && 'rotate-90')}
                    />
                  </span>
                ) : (
                  <span className="w-3.5 shrink-0" />
                )}
                <RowIcon row={r} />
                <span className="truncate" title={r.type === 'entry' ? r.dn : undefined}>
                  {r.prefix && <span className="font-mono text-xs text-muted">{r.prefix}</span>}
                  {r.label}
                </span>
                {r.type === 'entry' && entryChanges(batch, r.dn) && <ChangeDot />}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
