import { isUnder, joinDN, looksLikeDN, splitDN } from './dn'
import { nameFilter } from './filter'

/** What the header's query bar does with its text on Enter. */
export type QueryKind =
  | { kind: 'name'; filter: string }
  | { kind: 'filter'; filter: string }
  | { kind: 'dn'; dn: string }
  | { kind: 'empty' }

/** Each attribute=value pair has a type and exactly one unescaped "=". */
const isRDN = (rdn: string) =>
  splitDN(rdn, '+').every((p) => looksLikeDN(p) && p.replace(/\\./g, '').split('=').length === 2)

/**
 * text is a DN when it parses as one, no RDN value holds an unescaped "=" (so
 * memberOf=cn=x,... stays a filter) and it lies under baseDN; then a filter when it holds "("
 * or "="; else a name.
 */
export function classifyQuery(text: string, baseDN: string): QueryKind {
  const t = text.trim()
  if (!t) return { kind: 'empty' }
  const rdns = splitDN(t)
  if (rdns.every(isRDN) && isUnder(t, baseDN)) return { kind: 'dn', dn: joinDN(rdns) }
  if (/[(=]/.test(t)) return { kind: 'filter', filter: t }
  return { kind: 'name', filter: nameFilter(t) }
}
