import { describe, expect, it } from 'vitest'
import { nameFilter } from './filter'
import { classifyQuery, type QueryKind } from './query'

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
