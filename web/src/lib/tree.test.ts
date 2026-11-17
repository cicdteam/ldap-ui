import { describe, expect, it } from 'vitest'
import { normDN } from './dn'
import {
  TREE_PAGE,
  buildRows,
  childrenFromPage,
  entryKind,
  visibleExpanded,
  type ChildState,
  type Children,
  type EntryKind,
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
      more: true,
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

  it('names a uid or sAMAccountName child by its displayName or cn; a cn RDN gets no hint', () => {
    const c = childrenFromPage({
      entries: [
        entry('uid=jdoe,ou=p,dc=x', { cn: ['J. Doe'], displayName: ['John Doe'] }),
        entry('uid=adavis,ou=p,dc=x', { CN: ['Alice Davis'] }),
        entry('sAMAccountName=bchen,ou=p,dc=x', { cn: ['Bo Chen'] }),
        entry('cn=Doe\\, John,ou=p,dc=x', { cn: ['Doe, John'], displayName: ['John Doe'] }),
        entry('uid=svc,ou=p,dc=x'),
      ],
    })
    expect(Object.fromEntries(c.items.map((i) => [i.rdn, i.hint ?? null]))).toEqual({
      'uid=jdoe': 'John Doe',
      'uid=adavis': 'Alice Davis',
      'sAMAccountName=bchen': 'Bo Chen',
      'cn=Doe\\, John': null,
      'uid=svc': null,
    })
  })
})

describe('TREE_PAGE', () => {
  it('asks for 2000 children per container', () => {
    expect(TREE_PAGE).toBe(2000)
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

  it('keeps the rows whose label or hint holds the filter, with their ancestors', () => {
    const item = (rdn: string, parent: string, hint?: string, leaf = true) => ({
      dn: `${rdn},${parent}`,
      rdn,
      leaf,
      kind: (leaf ? 'user' : 'ou') as EntryKind,
      hint,
    })
    const base = 'dc=example,dc=org'
    const people = `ou=people,${base}`
    const groups = `ou=groups,${base}`
    const tree: Record<string, Children> = {
      [base]: {
        items: [
          item('ou=groups', base, undefined, false),
          item('ou=people', base, undefined, false),
          item('ou=services', base, undefined, false),
        ],
        more: false,
      },
      [people]: {
        items: [
          item('uid=adavis', people, 'Alice Davis'),
          item('uid=jdoe', people, 'John Doe'),
          item('uid=rwhite', people, 'Richard Doe'),
        ],
        more: true,
      },
      [groups]: { items: [item('cn=doers', groups), item('cn=devs', groups)], more: false },
      [`ou=services,${base}`]: { items: [item('uid=svc', `ou=services,${base}`)], more: false },
    }
    const expanded = new Set(Object.keys(tree))
    const rows = buildRows(roots, expanded, (dn) => ok(tree[dn]), 'DOE')
    expect(rows.map((r) => [r.label, r.hint, r.depth])).toEqual([
      [base, undefined, 0],
      ['groups', undefined, 1],
      ['doers', undefined, 2],
      ['people', undefined, 1],
      ['jdoe', 'John Doe', 2],
      ['rwhite', 'Richard Doe', 2],
    ])
    // No filter: every loaded row, the hint included.
    const all = buildRows(roots, expanded, (dn) => ok(tree[dn]))
    expect(all).toHaveLength(11)
    expect(all.find((r) => r.label === 'adavis')?.hint).toBe('Alice Davis')
  })

  it('keeps the selected entry and its parents under a filter that matches nothing there', () => {
    const base = 'dc=example,dc=org'
    const e2e = `ou=e2e,${base}`
    const children = (dn: string): ChildState =>
      dn === base
        ? ok({ items: [{ dn: e2e, rdn: 'ou=e2e', leaf: false, kind: 'ou' }], more: false })
        : ok({
            items: [{ dn: `uid=jdoe,${e2e}`, rdn: 'uid=jdoe', leaf: true, kind: 'user' }],
            more: false,
          })
    // ou=e2e was kept only as the parent of uid=jdoe; selecting it collapses it.
    const rows = buildRows(roots, new Set([base]), children, 'doe', 'OU=E2E,DC=Example,DC=Org')
    expect(rows.map((r) => r.label)).toEqual([base, 'e2e'])
    expect(buildRows(roots, new Set([base]), children, 'doe')).toEqual([])
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
