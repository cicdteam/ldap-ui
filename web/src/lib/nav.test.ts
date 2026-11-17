import { describe, expect, it } from 'vitest'
import {
  defaultColumns,
  parseColumns,
  readSearch,
  reconnectURL,
  safeNext,
  workspaceURL,
} from './nav'
import type { Info } from './types'

describe('safeNext', () => {
  it.each([
    ['/c/demo/entry?dn=x', '/c/demo/entry?dn=x'],
    ['/c/demo', '/c/demo'],
    [null, undefined],
    ['', undefined],
    ['//evil.example/c/x', undefined],
    ['https://evil.example/', undefined],
    ['/\\evil.example', undefined],
    ['/other', undefined],
  ])('%j', (next, want) => {
    expect(safeNext(next)).toBe(want)
  })
})

describe('columns', () => {
  const info = (ad: boolean): Info => ({
    baseDN: 'dc=x',
    url: 'ldap://x',
    startTLS: false,
    activeDirectory: ad,
    paging: true,
    passwordModify: false,
    encrypted: false,
    readOnly: false,
    insecureSkipVerify: false,
  })
  it('defaults per server', () => {
    expect(defaultColumns(info(true))).toEqual(['sAMAccountName', 'mail'])
    expect(defaultColumns(info(false))).toEqual(['uid', 'mail'])
  })
  it('parses comma or space separated, dedupes case-insensitively', () => {
    expect(parseColumns(' cn, mail  uid,,CN ')).toEqual(['cn', 'mail', 'uid'])
    expect(parseColumns('')).toEqual([])
  })
})

describe('workspace URLs', () => {
  const dn = 'cn=Doe\\, John+uid=jd,ou=Sales\\, EMEA,dc=example,dc=org'
  const search = {
    base: 'ou=Sales\\, EMEA,dc=example,dc=org',
    scope: 'one' as const,
    filter: '(cn=J*)',
    attrs: ['cn', 'mail'],
  }

  it('round-trips state through the URL', () => {
    const url = new URL(workspaceURL('my conn', { dn, search }, 'entry'), 'http://h')
    expect(url.pathname).toBe('/c/my%20conn/entry')
    expect(url.searchParams.get('dn')).toBe(dn)
    expect(readSearch(url.searchParams)).toEqual(search)
  })

  it('omits empty parts', () => {
    expect(workspaceURL('demo', { dn: '', search: null }, 'entry')).toBe('/c/demo/entry')
  })

  it('reads a missing or bad search', () => {
    expect(readSearch(new URLSearchParams('dn=x'))).toBeNull()
    expect(readSearch(new URLSearchParams('filter=(a=b)&scope=bogus'))).toEqual({
      base: '',
      scope: 'sub',
      filter: '(a=b)',
      attrs: [],
    })
  })
})

describe('reconnectURL', () => {
  it.each([
    ['/c/demo/entry', '?dn=x', '/', 'demo', '/c/demo/entry?dn=x'],
    ['/ldap/c/demo/entry', '?dn=x', '/ldap', 'demo', '/c/demo/entry?dn=x'],
    ['/c/my%20dir%2Fprod/search', '', '/', 'my dir/prod', '/c/my%20dir%2Fprod/search'],
  ])('%s%s under %s', (pathname, search, basename, connect, next) => {
    const url = reconnectURL(pathname, search, basename)
    expect(url?.startsWith('/?')).toBe(true)
    const p = new URLSearchParams(url!.slice(2))
    expect([p.get('connect'), p.get('next')]).toEqual([connect, next])
    expect(safeNext(p.get('next'))).toBe(next)
  })
  it('encodes the query', () => {
    expect(reconnectURL('/c/a&b/entry', '?dn=x&y=1', '/')).toBe(
      '/?connect=a%26b&next=%2Fc%2Fa%26b%2Fentry%3Fdn%3Dx%26y%3D1',
    )
  })
  it.each([
    ['/', '/'],
    ['/ldap/', '/ldap'],
    ['/settings', '/'],
  ])('is null off the workspace: %s under %s', (pathname, basename) => {
    expect(reconnectURL(pathname, '', basename)).toBeNull()
  })
})
