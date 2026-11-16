import { cellValue } from './csv'
import { rdnValue, splitDN } from './dn'
import type { Entry } from './types'

/** Entries a search asks for: the first, then one step up per "Load more". */
export const RESULT_LIMITS = [500, 1000, 2000, 5000]

/** The limit after current, or null at the last. */
export function nextLimit(current: number): number | null {
  return RESULT_LIMITS.find((l) => l > current) ?? null
}

/** The key of the Name column, which leads the results; no attribute is named ''. */
export const NAME_COLUMN = ''

/** The attributes the Name column reads; a search asks for them besides its columns. */
export const NAME_ATTRS = ['displayName', 'cn']

/**
 * The entries as an export holds them: the DN and the columns. displayName and cn go unless
 * picked as columns: the search asked for them only to show the Name column.
 */
export function withColumns(entries: Entry[], columns: string[]): Entry[] {
  const picked = new Set(columns.map((c) => c.toLowerCase()))
  const extra = new Set(NAME_ATTRS.map((a) => a.toLowerCase()).filter((a) => !picked.has(a)))
  return entries.map((e) => ({
    ...e,
    attributes: e.attributes?.filter((a) => !extra.has(a.name.split(';')[0].toLowerCase())),
  }))
}

/** The entry as nameOf takes it: each attribute's text values, binary ones left out. */
export function asText(e: Entry): { dn: string; attrs: Record<string, string[]> } {
  const attrs: Record<string, string[]> = {}
  for (const a of e.attributes ?? [])
    attrs[a.name] = (a.values ?? []).filter((v) => !v.base64).map((v) => v.text)
  return { dn: e.dn, attrs }
}

/** What a person calls the entry: displayName, else cn, else the RDN value. */
export function nameOf(e: { dn: string; attrs: Record<string, string[]> }): string {
  const first = (name: string) =>
    Object.entries(e.attrs).find(([k]) => k.toLowerCase() === name)?.[1][0]
  // The first pair of a multi-valued RDN (cn=Doe\, John+uid=jd).
  const rdn = splitDN(splitDN(e.dn)[0] ?? '', '+')[0]
  return first('displayname') ?? first('cn') ?? (rdn ? rdnValue(rdn) : e.dn)
}

export type Sort = { column: string; desc: boolean } | null

export function nextSort(sort: Sort, column: string): Sort {
  if (!sort || sort.column !== column) return { column, desc: false }
  return sort.desc ? null : { column, desc: true }
}

/** Sorts a copy by the column's display text; entries without a value go last either way. */
export function sortEntries(entries: Entry[], sort: Sort): Entry[] {
  if (!sort) return entries
  const text = (e: Entry) =>
    sort.column === NAME_COLUMN ? nameOf(asText(e)) : cellValue(e, sort.column)
  const keyed = entries.map((e) => ({ e, k: text(e) }))
  keyed.sort((a, b) => {
    if (!a.k || !b.k) return a.k ? -1 : b.k ? 1 : 0
    const c = a.k.localeCompare(b.k, undefined, { numeric: true, sensitivity: 'base' })
    return sort.desc ? -c : c
  })
  return keyed.map((x) => x.e)
}
