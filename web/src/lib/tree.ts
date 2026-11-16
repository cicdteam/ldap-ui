import { normDN, rdnType, rdnValue, splitDN } from './dn'
import { asText, nameOf } from './results'
import type { Page } from './types'

/** Children per tree page; bigger containers get a "more" row that opens them as a search. */
export const TREE_PAGE = 2000

export type EntryKind = 'user' | 'group' | 'ou' | 'domain' | 'other'

const KINDS: [EntryKind, string[]][] = [
  ['group', ['group', 'groupofnames', 'groupofuniquenames', 'posixgroup', 'groupofmembers']],
  ['user', ['person', 'user', 'inetorgperson', 'organizationalperson', 'posixaccount', 'computer']],
  ['ou', ['organizationalunit', 'container', 'builtindomain', 'organizationalrole']],
  ['domain', ['domain', 'dcobject', 'domaindns', 'organization']],
]

export function entryKind(objectClasses: string[]): EntryKind {
  const oc = new Set(objectClasses.map((c) => c.toLowerCase()))
  for (const [kind, names] of KINDS) if (names.some((n) => oc.has(n))) return kind
  return 'other'
}

export interface ChildItem {
  dn: string
  rdn: string
  /** Known to have no children (hasSubordinates FALSE or numSubordinates 0). */
  leaf: boolean
  kind: EntryKind
  /** The person's name beside an account RDN (uid=jdoe: John Doe). */
  hint?: string
}

export interface Children {
  items: ChildItem[]
  /** The container has more children than one page. */
  more: boolean
}

export function childrenFromPage(page: Page): Children {
  const items = (page.entries ?? []).map((e): ChildItem => {
    const attrs = e.attributes ?? []
    const values = (n: string) => attrs.find((a) => a.name.toLowerCase() === n)?.values ?? []
    const hs = values('hassubordinates')[0]?.text
    const ns = values('numsubordinates')[0]?.text
    const leaf = hs !== undefined ? hs.toUpperCase() === 'FALSE' : ns !== undefined && ns === '0'
    const rdn = splitDN(e.dn)[0] ?? e.dn
    // An account RDN says little about who it is; a cn RDN already is the name.
    const name = /^(uid|samaccountname)$/i.test(rdnType(rdn)) ? nameOf(asText(e)) : ''
    return {
      dn: e.dn,
      rdn,
      leaf,
      kind: entryKind(values('objectclass').map((v) => v.text)),
      // nameOf falls back to the RDN value, which the label already shows.
      hint: name && name !== rdnValue(rdn) ? name : undefined,
    }
  })
  items.sort((a, b) =>
    rdnValue(a.rdn).localeCompare(rdnValue(b.rdn), undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  )
  return { items, more: !!page.more || !!page.truncated }
}

export type ChildState =
  { status: 'pending' } | { status: 'error'; message: string } | { status: 'ok'; data: Children }

export interface TreeRow {
  key: string
  type: 'entry' | 'more' | 'loading' | 'error'
  /** The entry, or for more/loading/error rows the parent they belong to. */
  dn: string
  label: string
  /** "ou=" before the label; empty for roots and service rows. */
  prefix: string
  /** Shown muted after the label. */
  hint?: string
  depth: number
  expandable: boolean
  expanded: boolean
  kind: EntryKind
}

interface Root {
  dn: string
  kind: EntryKind
}

/**
 * Flattens the visible tree. children(dn) returns the load state of dn's children. A filter keeps
 * the entries whose label or hint holds it (any case), with their ancestors.
 */
export function buildRows(
  roots: Root[],
  expanded: Set<string>,
  children: (dn: string) => ChildState | undefined,
  filter = '',
): TreeRow[] {
  const rows: TreeRow[] = []
  // Roots may nest (a base DN below a naming context), so the same entry can
  // show twice; the root index keeps row keys unique.
  let root = 0
  const service = (type: TreeRow['type'], dn: string, label: string, depth: number): TreeRow => ({
    key: `${root}:${type}:${dn}`,
    type,
    dn,
    label,
    prefix: '',
    depth,
    expandable: false,
    expanded: false,
    kind: 'other',
  })
  const walk = (
    dn: string,
    label: string,
    prefix: string,
    kind: EntryKind,
    leaf: boolean,
    depth: number,
    hint?: string,
  ) => {
    const open = !leaf && expanded.has(normDN(dn))
    const self: TreeRow = {
      key: `${root}:entry:${dn}`,
      type: 'entry',
      dn,
      label,
      prefix,
      hint,
      depth,
      expandable: !leaf,
      expanded: open,
      kind,
    }
    rows.push(self)
    if (!open) return
    const st = children(dn)
    if (!st || st.status === 'pending') {
      rows.push(service('loading', dn, 'Loading…', depth + 1))
    } else if (st.status === 'error') {
      rows.push(service('error', dn, st.message, depth + 1))
    } else if (st.data.items.length === 0 && !st.data.more) {
      self.expandable = false
      self.expanded = false
    } else {
      for (const c of st.data.items) {
        const t = rdnType(c.rdn)
        walk(c.dn, rdnValue(c.rdn), t ? `${t}=` : '', c.kind, c.leaf, depth + 1, c.hint)
      }
      if (st.data.more) rows.push(service('more', dn, 'More entries… open as a list', depth + 1))
    }
  }
  roots.forEach((r, i) => {
    root = i
    walk(r.dn, r.dn, '', r.kind, false, 0)
  })
  return filter ? filterRows(rows, filter.toLowerCase()) : rows
}

function filterRows(rows: TreeRow[], q: string): TreeRow[] {
  const keep = new Set<number>()
  const path: number[] = [] // the ancestors of the row at hand
  rows.forEach((r, i) => {
    while (path.length && rows[path[path.length - 1]].depth >= r.depth) path.pop()
    const hit = (s?: string) => !!s && s.toLowerCase().includes(q)
    if (r.type === 'entry' && (hit(r.label) || hit(r.hint)))
      for (const j of [...path, i]) keep.add(j)
    path.push(i)
  })
  return rows.filter((_, i) => keep.has(i))
}

/** Expanded nodes whose ancestors are all open: the ones whose children must be loaded. */
export function visibleExpanded(
  roots: Root[],
  expanded: Set<string>,
  cached: (dn: string) => Children | undefined,
): string[] {
  const out: string[] = []
  const walk = (dn: string) => {
    // Nested roots reach a node twice; it is one query (keyed by the DN as spelled).
    if (!expanded.has(normDN(dn)) || out.includes(dn)) return
    out.push(dn)
    for (const c of cached(dn)?.items ?? []) if (!c.leaf) walk(c.dn)
  }
  roots.forEach((r) => walk(r.dn))
  return out
}
