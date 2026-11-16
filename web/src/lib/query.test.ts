import { describe, expect, it } from 'vitest'
import { nameFilter } from './filter'
import { classifyQuery, nameQuery, type QueryKind } from './query'

const base = 'dc=example,dc=org'

describe('classifyQuery', () => {
  it.each<[string, QueryKind]>([
    ['', { kind: 'empty' }],
    ['  ', { kind: 'empty' }],
    ['doe', { kind: 'name', filter: nameFilter('doe') }],
    ['John Doe', { kind: 'name', filter: nameFilter('John Doe') }],
    ['uid=jdoe', { kind: 'filter', filter: 'uid=jdoe' }],
    [
      ' (&(objectClass=person)(cn=a*)) ',
      { kind: 'filter', filter: '(&(objectClass=person)(cn=a*))' },
    ],
    [
      'uid=jdoe,ou=People,dc=example,dc=org',
      { kind: 'dn', dn: 'uid=jdoe,ou=People,dc=example,dc=org' },
    ],
    [
      'UID=jdoe,OU=People,DC=Example,DC=org',
      { kind: 'dn', dn: 'UID=jdoe,OU=People,DC=Example,DC=org' },
    ],
    [
      ' uid=jdoe, ou=People,dc=example,dc=org ',
      { kind: 'dn', dn: 'uid=jdoe,ou=People,dc=example,dc=org' },
    ],
    [
      'cn=Doe\\, John,ou=Sales\\, EMEA,dc=example,dc=org',
      { kind: 'dn', dn: 'cn=Doe\\, John,ou=Sales\\, EMEA,dc=example,dc=org' },
    ],
    ['dc=example,dc=org', { kind: 'dn', dn: 'dc=example,dc=org' }],
    // An RDN value holding an unescaped "=" is a filter value, not a DN.
    [
      'memberOf=cn=devs,ou=Groups,dc=example,dc=org',
      { kind: 'filter', filter: 'memberOf=cn=devs,ou=Groups,dc=example,dc=org' },
    ],
    ['cn=a\\=b,dc=example,dc=org', { kind: 'dn', dn: 'cn=a\\=b,dc=example,dc=org' }],
    // Not under the connection's base.
    ['cn=x,dc=other,dc=net', { kind: 'filter', filter: 'cn=x,dc=other,dc=net' }],
  ])('%j', (text, want) => {
    expect(classifyQuery(text, base)).toEqual(want)
  })
})

describe('nameQuery', () => {
  it.each(['doe', 'John Doe', 'j*doe', 'a\\b', 'Ёлкин', 'x)'])('gives back %j', (text) => {
    expect(nameQuery(nameFilter(text))).toBe(text)
    // And the bar runs the same search with it.
    expect(classifyQuery(text, base)).toEqual({ kind: 'name', filter: nameFilter(text) })
  })
  it('gives back the text trimmed, as nameFilter takes it', () => {
    expect(nameQuery(nameFilter('  doe '))).toBe('doe')
  })
  it.each([
    '(objectClass=*)',
    '(uid=doe*)',
    nameFilter(''),
    nameFilter('doe').replace('(uid=doe*)', '(uid=x*)'),
    nameFilter('doe') + ' ',
    // Upper-case hex: not what nameFilter writes.
    nameFilter('a*b').replaceAll('\\2a', '\\2A'),
    // The bar would run these as a filter, not as a name.
    nameFilter('uid=x'),
    nameFilter('j*(doe)'),
    nameFilter('x)(objectClass=*'),
  ])('is null for %j', (filter) => {
    expect(nameQuery(filter)).toBeNull()
  })
})
