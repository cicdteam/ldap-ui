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

/**
 * The text whose name search is filter (nameFilter(text) === filter), so the bar, Recent and Saved
 * show what was typed; null for any other filter, and for text the bar would not run as a name.
 */
export function nameQuery(filter: string): string | null {
  // The escaped text holds no raw "*", "(" or ")".
  const m = /^\(\|\(cn=\*([^*()]*)\*\)/.exec(filter)
  if (!m) return null
  const text = m[1].replace(/\\([0-9a-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  )
  return text && !/[(=]/.test(text) && nameFilter(text) === filter ? text : null
}
