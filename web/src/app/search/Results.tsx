import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, Download, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { api } from '../../lib/api'
import { entryChanges } from '../../lib/changes'
import { cellValue, toCSV } from '../../lib/csv'
import { parentDN, rdnDisplay, sameDN, splitDN } from '../../lib/dn'
import { entriesToLDIF } from '../../lib/ldif'
import { defaultColumns } from '../../lib/nav'
import { rowHeight, usePrefs } from '../../lib/prefs'
import { RESULT_LIMITS, nextLimit, nextSort, sortEntries, type Sort } from '../../lib/results'
import type { SearchState } from '../../lib/storage'
import { ChangeDot } from '../../ui/Badge'
import { Banner, ErrorBanner } from '../../ui/Banner'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { download } from '../../ui/download'
import { Spinner } from '../../ui/Spinner'
import { useBatch } from '../batch'
import { useWorkspace } from '../context'
import { searchKey } from '../queries'

// The sticky header row (h-7 buttons plus a 1px bottom border) sits in the scroll element
// above the rows. The virtualizer does not know about it, so scrolling to a row reserves
// this much at the bottom of the viewport. ponytail: assumes the 16px rem that h-7 is
// based on; measure the header if the root font size ever changes.
const HEADER_HEIGHT = 29

function Examples() {
  const ws = useWorkspace()
  const examples = ws.info.activeDirectory
    ? [
        ['People', '(&(objectCategory=person)(objectClass=user))'],
        ['Groups', '(objectClass=group)'],
        [
          'Disabled accounts',
          '(&(objectCategory=person)(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=2))',
        ],
      ]
    : [
        ['People', '(objectClass=person)'],
        [
          'Groups',
          '(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))',
        ],
        ['Organizational units', '(objectClass=organizationalUnit)'],
      ]
  return (
    <div className="space-y-2 p-4 text-muted">
      <p className="flex items-center gap-2">
        <Search className="h-4 w-4" /> Type a filter and press Run, or pick an entry in the tree.
        Try:
      </p>
      <ul className="space-y-1">
        {examples.map(([label, filter]) => (
          <li key={label}>
            <button
              type="button"
              className="text-left hover:text-fg"
              onClick={() =>
                ws.runSearch({ base: '', scope: 'sub', filter, attrs: defaultColumns(ws.info) })
              }
            >
              <span className="text-fg">{label}</span>{' '}
              <span className="font-mono text-xs">{filter}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Results() {
  const ws = useWorkspace()
  if (!ws.search) return <Examples />
  // Keyed per run so the limit, the sort and the scroll position start over.
  return <Listing key={[...searchKey(ws.conn, ws.search), ws.runs].join('\0')} search={ws.search} />
}

function Listing({ search }: { search: SearchState }) {
  const ws = useWorkspace()
  const qc = useQueryClient()
  const { density } = usePrefs()
  const batch = useBatch(ws.conn)
  const key = searchKey(ws.conn, search)
  const attrs = search.attrs.length ? search.attrs : defaultColumns(ws.info)
  // Load more runs the same search again with the next limit; the server keeps nothing between
  // requests. The rows shown stay until the bigger answer arrives.
  const [limit, setLimit] = useState(RESULT_LIMITS[0])
  const prev = RESULT_LIMITS.findLast((l) => l < limit)
  const q = useQuery({
    queryKey: [...key, limit],
    queryFn: ({ signal }) =>
      api.search(
        ws.conn,
        {
          base: search.base || ws.info.baseDN,
          scope: search.scope,
          filter: search.filter,
          attributes: attrs,
          sizeLimit: limit,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  })
  const more = !!q.data?.more
  const next = nextLimit(limit)
  const [sort, setSort] = useState<Sort>(null)
  const entries = q.data?.entries
  const rows = useMemo(() => sortEntries(entries ?? [], sort), [entries, sort])
  // The active row is the selected entry, so it stays right after sorting, paging or a
  // selection made elsewhere (tree, breadcrumbs).
  const active = useMemo(
    () => (ws.dn ? rows.findIndex((r) => sameDN(r.dn, ws.dn)) : -1),
    [rows, ws.dn],
  )
  const refetch = () => void q.refetch()
  const cancel = () => {
    void qc.cancelQueries({ queryKey: key })
    // A canceled Load more leaves the smaller answer on screen: go back to its limit.
    if (q.isPlaceholderData && prev) setLimit(prev)
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual cannot be memoized; the app does not use the React Compiler, so this is informational only
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight(density),
    overscan: 12,
    scrollPaddingEnd: HEADER_HEIGHT,
  })
  useEffect(() => virt.measure(), [density, virt])

  const move = (i: number) => {
    if (i < 0 || i >= rows.length) return
    virt.scrollToIndex(i, { align: 'auto' })
    // Replace, so arrowing through rows does not leave one history entry per row.
    ws.select(rows[i].dn, { replace: true })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }
    if (e.key in step) {
      e.preventDefault()
      move(Math.min(Math.max(active + step[e.key], 0), rows.length - 1))
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      move(e.key === 'Home' ? 0 : rows.length - 1)
    }
  }

  const columns = ['dn', ...attrs]
  const grid = {
    gridTemplateColumns: `minmax(16rem, 2fr) repeat(${attrs.length}, minmax(7rem, 1fr))`,
  }
  const canceled = q.isPending && q.fetchStatus === 'idle'

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2 text-xs">
        <span className="text-muted">
          {q.isPending ? 'Searching…' : `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`}
          {more && ', more on the server'}
          {sort && more && ' (sorting loaded rows)'}
        </span>
        {q.isFetching && <Spinner />}
        <div className="ml-auto flex items-center gap-1">
          {q.isFetching && (
            <Button size="sm" onClick={cancel}>
              Cancel
            </Button>
          )}
          {more && next !== null && (
            <Button
              size="sm"
              disabled={q.isFetching}
              title={`Run the search again for up to ${next} entries`}
              onClick={() => setLimit(next)}
            >
              Load more
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={!rows.length}
            title="Export loaded rows as CSV"
            onClick={() => download(`${ws.conn}-search.csv`, toCSV(rows, attrs), 'text/csv')}
          >
            <Download className="h-3.5 w-3.5" /> CSV
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!rows.length}
            title="Export loaded rows as LDIF (the selected columns only)"
            onClick={() => download(`${ws.conn}-search.ldif`, entriesToLDIF(rows), 'text/plain')}
          >
            <Download className="h-3.5 w-3.5" /> LDIF
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Clear results"
            title="Clear the results and go back to the examples"
            onClick={() => ws.runSearch(null)}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {canceled && (
        <Banner
          tone="info"
          action={
            <Button size="sm" onClick={refetch}>
              Run again
            </Button>
          }
        >
          Search canceled.
        </Banner>
      )}
      {q.isError && (
        <ErrorBanner
          error={q.error}
          action={
            <>
              {prev && (
                // The smaller answer stays cached for gcTime, so going back is instant.
                <Button size="sm" onClick={() => setLimit(prev)}>
                  Show the first {prev}
                </Button>
              )}
              <Button size="sm" onClick={refetch}>
                Retry
              </Button>
            </>
          }
        />
      )}
      {more && next === null && !q.isPlaceholderData && (
        <Banner tone="info">
          Showing the first {limit.toLocaleString('en-US')} entries; refine the search to see the
          rest
        </Banner>
      )}
      {q.data?.truncated && (
        <Banner tone="warn">
          The search stopped early (a size, time or response limit). Showing what arrived.
        </Banner>
      )}
      {!!q.data?.referrals?.length && (
        <Banner tone="info">
          Referrals (not followed):{' '}
          {q.data.referrals.map((r) => (
            <span key={r} className="mr-2 font-mono text-xs">
              {r}
            </span>
          ))}
        </Banner>
      )}
      <div
        ref={scrollRef}
        role="grid"
        aria-label="Search results"
        aria-rowcount={rows.length + 1}
        tabIndex={0}
        aria-activedescendant={active >= 0 ? `result-${active}` : undefined}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto outline-none"
      >
        <div
          role="row"
          style={grid}
          className="sticky top-0 z-10 grid min-w-max border-b border-border bg-panel text-xs"
        >
          {columns.map((c) => {
            const sorted = sort?.column === c
            return (
              <div
                key={c}
                role="columnheader"
                aria-sort={sorted ? (sort.desc ? 'descending' : 'ascending') : 'none'}
              >
                <button
                  type="button"
                  onClick={() => setSort(nextSort(sort, c))}
                  className="flex h-7 w-full items-center gap-1 px-2 text-left font-semibold hover:bg-hover"
                >
                  {c === 'dn' ? 'Entry' : c}
                  {sorted &&
                    (sort.desc ? (
                      <ArrowDown className="h-3 w-3" />
                    ) : (
                      <ArrowUp className="h-3 w-3" />
                    ))}
                </button>
              </div>
            )
          })}
        </div>
        {q.isSuccess && rows.length === 0 && <p className="p-4 text-muted">No entries match.</p>}
        <div style={{ height: virt.getTotalSize(), position: 'relative' }} className="min-w-max">
          {virt.getVirtualItems().map((v) => {
            const e = rows[v.index]
            const rdns = splitDN(e.dn)
            const selected = v.index === active
            return (
              <div
                key={e.dn}
                id={`result-${v.index}`}
                role="row"
                aria-selected={selected}
                onClick={() => ws.select(e.dn)}
                style={{ ...grid, height: v.size, transform: `translateY(${v.start}px)` }}
                className={cn(
                  'absolute top-0 left-0 grid w-full cursor-default items-center border-b border-border/50 hover:bg-hover',
                  selected && 'bg-selected shadow-[inset_2px_0_0_var(--accent)]',
                )}
              >
                <div role="gridcell" className="truncate px-2" title={e.dn}>
                  {entryChanges(batch, e.dn) && (
                    <span className="mr-1 align-middle">
                      <ChangeDot />
                    </span>
                  )}
                  <span className="font-medium">{rdns[0] ? rdnDisplay(rdns[0]) : e.dn}</span>
                  <span className="ml-1 font-mono text-[11px] text-muted">{parentDN(e.dn)}</span>
                </div>
                {attrs.map((c) => (
                  <div
                    key={c}
                    role="gridcell"
                    className="truncate px-2 font-mono text-xs"
                    title={cellValue(e, c)}
                  >
                    {cellValue(e, c)}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
