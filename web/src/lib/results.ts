import { isApiError } from './api'
import { cellValue } from './csv'
import type { Entry, Page } from './types'

export const RESULT_PAGE = 500

export interface Listing {
  entries: Entry[]
  truncated: boolean
  referrals: string[]
}

export function collect(pages: Page[]): Listing {
  return {
    entries: pages.flatMap((p) => p.entries ?? []),
    truncated: pages.some((p) => p.truncated),
    referrals: pages.flatMap((p) => p.referrals ?? []),
  }
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

export function isCursorExpired(e: unknown): boolean {
  return isApiError(e) && e.code === 'cursor_expired'
}
