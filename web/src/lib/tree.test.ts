import { describe, expect, it } from 'vitest'
import { normDN } from './dn'
import {
  buildRows,
  childrenFromPage,
  entryKind,
  visibleExpanded,
  type ChildState,
  type Children,
} from './tree'
import type { Entry } from './types'

const entry = (dn: string, attrs: Record<string, string[]> = {}): Entry => ({
  dn,
  attributes: Object.entries(attrs).map(([name, vals]) => ({
    name,
    values: vals.map((text) => ({ text })),
  })),
})

describe('entryKind', () => {
  it.each([
    [['top', 'groupOfNames'], 'group'],
    [['top', 'person', 'organizationalPerson', 'user'], 'user'],
    [['inetOrgPerson'], 'user'],
    [['organizationalUnit'], 'ou'],
    [['container'], 'ou'],
    [['dcObject', 'organization'], 'domain'],
    [['applicationProcess'], 'other'],
    [[], 'other'],
  ])('%j -> %s', (ocs, want) => {
    expect(entryKind(ocs)).toBe(want)
  })
})

describe('childrenFromPage', () => {
  it('detects leaves, sorts naturally and reports more', () => {
    const c = childrenFromPage({
      entries: [
        entry('uid=user10,ou=p,dc=x', {
          objectClass: ['inetOrgPerson'],
          hasSubordinates: ['FALSE'],
        }),
        entry('uid=user2,ou=p,dc=x', {
          objectClass: ['inetOrgPerson'],
          hasSubordinates: ['FALSE'],
        }),
        entry('ou=Sub,ou=p,dc=x', {
          objectClass: ['organizationalUnit'],
          hasSubordinates: ['TRUE'],
        }),
        entry('cn=Empty,ou=p,dc=x', { objectClass: ['container'], numSubordinates: ['0'] }),
        entry('cn=Unknown,ou=p,dc=x', { objectClass: ['container'] }),
      ],
      cursor: 'c1',
    })
    expect(c.more).toBe(true)
    expect(c.items.map((i) => [i.rdn, i.leaf, i.kind])).toEqual([
      ['cn=Empty', true, 'ou'],
      ['ou=Sub', false, 'ou'],
      ['cn=Unknown', false, 'ou'],
      ['uid=user2', true, 'user'],
      ['uid=user10', true, 'user'],
    ])
    expect(childrenFromPage({ entries: [], truncated: true }).more).toBe(true)
    expect(childrenFromPage({}).items).toEqual([])
  })
})

describe('buildRows', () => {
  const roots = [{ dn: 'dc=example,dc=org', kind: 'domain' as const }]
  const ok = (data: Children): ChildState => ({ status: 'ok', data })

  it('shows a collapsed root', () => {
    const rows = buildRows(roots, new Set(), () => undefined)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: 'entry',
      label: 'dc=example,dc=org',
      prefix: '',
      depth: 0,
      expandable: true,
      expanded: false,
    })
  })

  it('shows loading, error, children and the more row', () => {
    const expanded = new Set(['dc=example,dc=org'])
    expect(buildRows(roots, expanded, () => ({ status: 'pending' }))[1]).toMatchObject({
      type: 'loading',
      depth: 1,
    })
    expect(
      buildRows(roots, expanded, () => ({ status: 'error', message: 'denied' }))[1],
    ).toMatchObject({
      type: 'error',
      label: 'denied',
      dn: 'dc=example,dc=org',
    })
    // Expanded keys are normDN values, so a differently cased DN still matches.
    const rows = buildRows(
      roots,
      new Set([normDN('DC=Example, DC=Org'), 'ou=people,dc=example,dc=org']),
      (dn) =>
        dn === 'dc=example,dc=org'
          ? ok({
              items: [
                { dn: 'ou=people,dc=example,dc=org', rdn: 'ou=people', leaf: false, kind: 'ou' },
              ],
              more: false,
            })
          : ok({
              items: [
                { dn: 'uid=a,ou=people,dc=example,dc=org', rdn: 'uid=a', leaf: true, kind: 'user' },
              ],
              more: true,
            }),
    )
    expect(rows.map((r) => [r.type, r.label, r.prefix, r.depth])).toEqual([
      ['entry', 'dc=example,dc=org', '', 0],
      ['entry', 'people', 'ou=', 1],
      ['entry', 'a', 'uid=', 2],
      ['more', 'More entries… open as a list', '', 2],
    ])
    expect(rows[3].dn).toBe('ou=people,dc=example,dc=org')
  })

  it('turns an expanded node without children into a leaf', () => {
    const rows = buildRows(roots, new Set(['dc=example,dc=org']), () =>
      ok({ items: [], more: false }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ expandable: false, expanded: false })
  })

  it('keeps row keys unique when roots nest', () => {
    // A profile base DN below a naming context shows the same subtree twice.
    const nested = [
      { dn: 'ou=people,dc=example,dc=org', kind: 'ou' as const },
      { dn: 'dc=example,dc=org', kind: 'domain' as const },
    ]
    const rows = buildRows(
      nested,
      new Set(['ou=people,dc=example,dc=org', 'dc=example,dc=org']),
      (dn) =>
        dn === 'dc=example,dc=org'
          ? ok({
              items: [
                { dn: 'ou=people,dc=example,dc=org', rdn: 'ou=people', leaf: false, kind: 'ou' },
              ],
              more: false,
            })
          : ok({
              items: [
                { dn: 'uid=a,ou=people,dc=example,dc=org', rdn: 'uid=a', leaf: true, kind: 'user' },
              ],
              more: true,
            }),
    )
    expect(rows.map((r) => [r.type, r.label])).toEqual([
      ['entry', 'ou=people,dc=example,dc=org'],
      ['entry', 'a'],
      ['more', 'More entries… open as a list'],
      ['entry', 'dc=example,dc=org'],
      ['entry', 'people'],
      ['entry', 'a'],
      ['more', 'More entries… open as a list'],
    ])
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })
})

describe('visibleExpanded', () => {
  it('lists expanded nodes whose ancestors are open', () => {
    const roots = [{ dn: 'dc=x', kind: 'domain' as const }]
    const cache: Record<string, Children> = {
      'dc=x': { items: [{ dn: 'ou=a,dc=x', rdn: 'ou=a', leaf: false, kind: 'ou' }], more: false },
    }
    const expanded = new Set(['dc=x', 'ou=a,dc=x', 'ou=hidden,ou=b,dc=x'])
    expect(visibleExpanded(roots, expanded, (dn) => cache[dn])).toEqual(['dc=x', 'ou=a,dc=x'])
  })

  it('lists a node once when roots nest', () => {
    const roots = [
      { dn: 'ou=a,dc=x', kind: 'ou' as const },
      { dn: 'dc=x', kind: 'domain' as const },
    ]
    const cache: Record<string, Children> = {
      'dc=x': { items: [{ dn: 'ou=a,dc=x', rdn: 'ou=a', leaf: false, kind: 'ou' }], more: false },
    }
    const expanded = new Set(['dc=x', 'ou=a,dc=x'])
    // Each DN is one children query; useQueries warns about duplicate keys.
    expect(visibleExpanded(roots, expanded, (dn) => cache[dn])).toEqual(['ou=a,dc=x', 'dc=x'])
  })
})
