import { cellValue } from './csv'
import type { Entry } from './types'

/** Entries a search asks for: the first, then one step up per "Load more". */
export const RESULT_LIMITS = [500, 1000, 2000, 5000]

/** The limit after current, or null at the last. */
export function nextLimit(current: number): number | null {
  return RESULT_LIMITS.find((l) => l > current) ?? null
}

export type Sort = { column: string; desc: boolean } | null

export function nextSort(sort: Sort, column: string): Sort {
  if (!sort || sort.column !== column) return { column, desc: false }
  return sort.desc ? null : { column, desc: true }
}

/** Sorts a copy by the column's display text; entries without a value go last either way. */
export function sortEntries(entries: Entry[], sort: Sort): Entry[] {
  if (!sort) return entries
  const keyed = entries.map((e) => ({ e, k: cellValue(e, sort.column) }))
  keyed.sort((a, b) => {
    if (!a.k || !b.k) return a.k ? -1 : b.k ? 1 : 0
    const c = a.k.localeCompare(b.k, undefined, { numeric: true, sensitivity: 'base' })
    return sort.desc ? -c : c
  })
  return keyed.map((x) => x.e)
}
