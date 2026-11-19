import { describe, expect, it } from 'vitest'
import {
  NAME_COLUMN,
  RESULT_LIMITS,
  asText,
  nameOf,
  nextLimit,
  nextSort,
  sortEntries,
  withColumns,
} from './results'
import type { Entry } from './types'

const e = (dn: string, cn?: string): Entry => ({
  dn,
  attributes: cn === undefined ? [] : [{ name: 'cn', values: [{ text: cn }] }],
})

describe('nextLimit', () => {
  it('steps through the limits and stops at the last', () => {
    expect(RESULT_LIMITS).toEqual([500, 1000, 2000, 5000])
    expect(nextLimit(500)).toBe(1000)
    expect(nextLimit(1000)).toBe(2000)
    expect(nextLimit(2000)).toBe(5000)
    expect(nextLimit(5000)).toBeNull()
  })
})

describe('sorting', () => {
  const list = [
    e('cn=user10', 'user10'),
    e('cn=User2', 'User2'),
    e('cn=none'),
    e('cn=alpha', 'alpha'),
  ]

  it('cycles ascending, descending, off', () => {
    expect(nextSort(null, 'cn')).toEqual({ column: 'cn', desc: false })
    expect(nextSort({ column: 'cn', desc: false }, 'cn')).toEqual({ column: 'cn', desc: true })
    expect(nextSort({ column: 'cn', desc: true }, 'cn')).toBeNull()
    expect(nextSort({ column: 'cn', desc: true }, 'mail')).toEqual({ column: 'mail', desc: false })
  })

  it('sorts naturally and case-insensitively, empty values last', () => {
    expect(sortEntries(list, { column: 'cn', desc: false }).map((x) => x.dn)).toEqual([
      'cn=alpha',
      'cn=User2',
      'cn=user10',
      'cn=none',
    ])
    expect(sortEntries(list, { column: 'cn', desc: true }).map((x) => x.dn)).toEqual([
      'cn=user10',
      'cn=User2',
      'cn=alpha',
      'cn=none',
    ])
    expect(sortEntries(list, null)).toBe(list)
  })
})

describe('nameOf', () => {
  const dn = 'uid=jdoe,ou=People,dc=example,dc=org'

  it('takes displayName first', () => {
    expect(nameOf({ dn, attrs: { cn: ['Doe, John'], displayName: ['John Doe'] } })).toBe('John Doe')
  })

  it('takes cn when there is no displayName', () => {
    expect(nameOf({ dn, attrs: { cn: ['Doe, John'], displayName: [] } })).toBe('Doe, John')
  })

  it('matches attribute names in any letter case', () => {
    expect(nameOf({ dn, attrs: { CN: ['Doe, John'], displayname: ['John Doe'] } })).toBe('John Doe')
  })

  it('falls back to the RDN value with escapes decoded', () => {
    expect(nameOf({ dn, attrs: {} })).toBe('jdoe')
    expect(
      nameOf({ dn: 'cn=Doe\\, John+uid=jd,ou=Sales\\, EMEA,dc=example,dc=org', attrs: {} }),
    ).toBe('Doe, John')
    expect(nameOf({ dn: 'cn=M\\C3\\BCller,dc=example,dc=org', attrs: {} })).toBe('Müller')
  })
})

describe('asText', () => {
  it('maps attribute names to their text values, leaving out binary ones', () => {
    const entry: Entry = {
      dn: 'cn=a,dc=x',
      attributes: [
        { name: 'cn', values: [{ text: 'a' }, { text: 'b' }] },
        { name: 'jpegPhoto', values: [{ text: '/9j/', base64: true }] },
        { name: 'userPassword', masked: 1 },
      ],
    }
    expect(asText(entry)).toEqual({
      dn: 'cn=a,dc=x',
      attrs: { cn: ['a', 'b'], jpegPhoto: [], userPassword: [] },
    })
  })
})

describe('sorting by the name', () => {
  it('sorts by displayName, else cn, else the RDN value', () => {
    const list: Entry[] = [
      { dn: 'uid=zed,dc=x', attributes: [{ name: 'displayName', values: [{ text: 'Bob' }] }] },
      e('uid=b,dc=x', 'Carol'),
      { dn: 'uid=alice,dc=x' },
    ]
    expect(sortEntries(list, { column: NAME_COLUMN, desc: false }).map((x) => x.dn)).toEqual([
      'uid=alice,dc=x',
      'uid=zed,dc=x',
      'uid=b,dc=x',
    ])
  })
})

describe('withColumns', () => {
  const entry = (...names: string[]): Entry => ({
    dn: 'uid=jdoe,dc=example,dc=org',
    attributes: names.map((name) => ({ name, values: [{ text: name }] })),
  })
  const kept = (columns: string[], ...names: string[]) =>
    withColumns([entry(...names)], columns)[0].attributes?.map((a) => a.name)

  it('drops displayName and cn, which only the Name column asked for', () => {
    expect(kept(['uid', 'mail'], 'displayName', 'cn', 'cn;lang-de', 'uid', 'mail')).toEqual([
      'uid',
      'mail',
    ])
  })
  it('keeps them when picked as columns, whatever the case', () => {
    expect(kept(['CN', 'mail'], 'displayName', 'cn', 'cn;lang-de', 'mail')).toEqual([
      'cn',
      'cn;lang-de',
      'mail',
    ])
    expect(kept(['displayname'], 'DisplayName', 'cn')).toEqual(['DisplayName'])
  })
  it('keeps them when * is picked', () => {
    expect(kept(['*'], 'displayName', 'cn', 'uid')).toEqual(['displayName', 'cn', 'uid'])
  })
  it('keeps the DN and leaves the entries it was given alone', () => {
    const e = entry('cn', 'uid')
    expect(withColumns([e], ['uid'])[0].dn).toBe(e.dn)
    expect(e.attributes?.map((a) => a.name)).toEqual(['cn', 'uid'])
  })
})
