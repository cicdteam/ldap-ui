import { describe, expect, it } from 'vitest'
import {
  ancestorsWithin,
  breadcrumbs,
  isUnder,
  looksLikeDN,
  normDN,
  parentDN,
  rdnDisplay,
  rdnType,
  rdnValue,
  sameDN,
  splitDN,
  unescapeDNValue,
} from './dn'

const doe = 'cn=Doe\\, John,ou=Sales\\, EMEA,dc=example,dc=org'

describe('splitDN', () => {
  it.each([
    ['', []],
    ['dc=org', ['dc=org']],
    ['cn=a,dc=org', ['cn=a', 'dc=org']],
    ['cn=a, dc=org', ['cn=a', 'dc=org']],
    [doe, ['cn=Doe\\, John', 'ou=Sales\\, EMEA', 'dc=example', 'dc=org']],
    ['cn=a\\2Cb,dc=org', ['cn=a\\2Cb', 'dc=org']],
    ['cn=trailing\\ ,dc=org', ['cn=trailing\\ ', 'dc=org']],
    ['cn=a+uid=b,dc=org', ['cn=a+uid=b', 'dc=org']],
    ['cn=back\\\\,dc=org', ['cn=back\\\\', 'dc=org']],
  ])('%s', (dn, want) => {
    expect(splitDN(dn)).toEqual(want)
  })
})

describe('values', () => {
  it('unescapes RFC 4514 escapes and hex UTF-8', () => {
    expect(unescapeDNValue('Doe\\, John')).toBe('Doe, John')
    expect(unescapeDNValue('J\\C3\\BCrgen')).toBe('Jürgen')
    expect(unescapeDNValue('a\\2Cb')).toBe('a,b')
    expect(unescapeDNValue('Jürgen 😀')).toBe('Jürgen 😀')
    expect(unescapeDNValue('back\\\\')).toBe('back\\')
  })

  it('splits an RDN into type and value', () => {
    expect(rdnType('cn=Doe\\, John')).toBe('cn')
    expect(rdnValue('cn=Doe\\, John')).toBe('Doe, John')
    expect(rdnDisplay('cn=Doe\\, John')).toBe('cn=Doe, John')
    expect(rdnValue('cn=a\\=b')).toBe('a=b')
  })

  it('shows hidden characters in rdnDisplay only', () => {
    const rdn = 'cn=\\E2\\80\\AEnimda'
    expect(rdnDisplay(rdn)).toBe('cn=<U+202E>nimda')
    expect(rdnValue(rdn)).toBe('\u202Enimda')
    expect(normDN(rdn)).toBe('cn=\u202Enimda')
  })
})

describe('relations', () => {
  it('finds the parent', () => {
    expect(parentDN(doe)).toBe('ou=Sales\\, EMEA,dc=example,dc=org')
    expect(parentDN('dc=org')).toBe('')
  })

  it('compares case-insensitively', () => {
    expect(sameDN('CN=A,DC=Org', 'cn=a, dc=org')).toBe(true)
    expect(sameDN('cn=a,dc=org', 'cn=b,dc=org')).toBe(false)
  })

  it('compares escaped values by their meaning', () => {
    expect(sameDN('cn=Doe\\2C John,dc=org', 'cn=Doe\\, John,dc=org')).toBe(true)
    expect(isUnder('cn=x,ou=Sales\\2C EMEA,dc=org', 'ou=Sales\\, EMEA,dc=org')).toBe(true)
    expect(sameDN('cn=a\\,dc=org', 'cn=a,dc=org')).toBe(false)
  })

  it('builds a lowercased, unescaped and re-escaped comparison key', () => {
    expect(normDN('CN=Doe\\2C John,DC=Org')).toBe('cn=doe\\, john,dc=org')
    expect(normDN('uid=user001,ou=people,dc=example,dc=org')).toBe(
      'uid=user001,ou=people,dc=example,dc=org',
    )
  })

  it('checks containment by whole RDNs', () => {
    expect(isUnder(doe, 'dc=example,dc=org')).toBe(true)
    expect(isUnder('dc=example,dc=org', 'dc=example,dc=org')).toBe(true)
    expect(isUnder('dc=badexample,dc=org', 'dc=example,dc=org')).toBe(false)
    expect(isUnder('dc=org', 'dc=example,dc=org')).toBe(false)
  })

  it('lists ancestors from the root down', () => {
    expect(ancestorsWithin(doe, 'dc=example,dc=org')).toEqual([
      'dc=example,dc=org',
      'ou=Sales\\, EMEA,dc=example,dc=org',
    ])
    expect(ancestorsWithin('dc=example,dc=org', 'dc=example,dc=org')).toEqual([])
    expect(ancestorsWithin('cn=x,dc=other', 'dc=example,dc=org')).toEqual([])
  })
})

describe('breadcrumbs', () => {
  it('collapses the base DN into one crumb', () => {
    expect(breadcrumbs(doe, 'dc=example,dc=org')).toEqual([
      { label: 'dc=example,dc=org', dn: 'dc=example,dc=org' },
      { label: 'ou=Sales, EMEA', dn: 'ou=Sales\\, EMEA,dc=example,dc=org' },
      { label: 'cn=Doe, John', dn: doe },
    ])
  })

  it('shows every RDN outside the base', () => {
    expect(breadcrumbs('cn=x,dc=other', 'dc=example,dc=org')).toEqual([
      { label: 'dc=other', dn: 'dc=other' },
      { label: 'cn=x', dn: 'cn=x,dc=other' },
    ])
  })
})

describe('looksLikeDN', () => {
  it.each([
    ['cn=admin,dc=example,dc=org', true],
    ['  uid=jdoe', true],
    ['2.5.4.3=x', true],
    ['john', false],
    ['john doe', false],
    ['=x', false],
  ])('%s', (s, want) => {
    expect(looksLikeDN(s)).toBe(want)
  })
})
