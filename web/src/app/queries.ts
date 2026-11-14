import { useQuery, type QueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { nameFilter } from '../lib/filter'
import type { SearchState } from '../lib/storage'

export const entryKey = (conn: string, dn: string) => ['c', conn, 'entry', dn] as const
export const childrenKey = (conn: string, dn: string) => ['c', conn, 'children', dn] as const
export const searchKey = (conn: string, s: SearchState) =>
  ['c', conn, 'search', s.base, s.scope, s.filter, s.attrs.join(',')] as const

/**
 * After an add, delete or rename: tree children and search results reload, and the entry at gone
 * (deleted or renamed away) is marked stale, so it is read again if it is shown.
 */
export function afterWrite(qc: QueryClient, conn: string, gone?: string): void {
  if (gone) void qc.invalidateQueries({ queryKey: entryKey(conn, gone), refetchType: 'none' })
  for (const k of ['children', 'search']) void qc.invalidateQueries({ queryKey: ['c', conn, k] })
}

export function useEntry(conn: string, dn: string) {
  return useQuery({
    queryKey: entryKey(conn, dn),
    queryFn: ({ signal }) => api.entry(conn, dn, signal),
    enabled: dn !== '',
  })
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/**
 * Entries filter(text) finds, by name by default as the palette does (text: two characters or
 * more).
 */
export function useFind(
  conn: string,
  base: string,
  text: string,
  enabled: boolean,
  filter: (text: string) => string = nameFilter,
) {
  const f = filter(text)
  return useQuery({
    queryKey: ['c', conn, 'find', f],
    queryFn: ({ signal }) =>
      api.search(
        conn,
        {
          base,
          scope: 'sub',
          filter: f,
          attributes: ['cn', 'displayName', 'uid', 'sAMAccountName', 'mail', 'objectClass'],
          sizeLimit: 20,
        },
        signal,
      ),
    enabled,
    staleTime: 30_000,
  })
}
