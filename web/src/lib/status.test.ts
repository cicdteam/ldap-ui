import { describe, expect, it } from 'vitest'
import { connectionStatus, pendingText, plural, type StatusTone } from './status'

const info = {
  url: 'ldaps://samba:636',
  startTLS: false,
  encrypted: false,
  insecureSkipVerify: false,
  activeDirectory: false,
}

describe('connectionStatus transport', () => {
  it.each<[string, boolean, boolean, boolean, string, StatusTone]>([
    ['plain', false, false, false, 'not encrypted', 'warn'],
    ['plain, skip verify', false, true, false, 'not encrypted', 'warn'],
    ['ldaps', true, false, false, 'TLS', 'ok'],
    ['StartTLS', true, false, true, 'StartTLS', 'ok'],
    ['ldaps, skip verify', true, true, false, 'TLS, certificate not verified', 'danger'],
    ['StartTLS, skip verify', true, true, true, 'StartTLS, certificate not verified', 'danger'],
  ])('%s', (_, encrypted, insecureSkipVerify, startTLS, text, tone) => {
    const got = connectionStatus({ ...info, encrypted, insecureSkipVerify, startTLS })
    expect(got.transport).toEqual({ text, tone })
  })
})

describe('connectionStatus server', () => {
  it.each<[string, boolean, string | undefined, string]>([
    ['AD', true, undefined, 'Active Directory'],
    ['AD with a vendor', true, 'Samba Team', 'Active Directory'],
    ['vendor', false, 'OpenLDAP', 'OpenLDAP'],
    ['blank vendor', false, '', 'LDAP'],
    ['whitespace vendor', false, '  ', 'LDAP'],
    ['no vendor', false, undefined, 'LDAP'],
  ])('%s', (_, activeDirectory, vendor, want) => {
    expect(connectionStatus({ ...info, activeDirectory, vendor }).server).toBe(want)
  })
})

describe('pendingText', () => {
  it.each<[number, number, string]>([
    [1, 1, '1 change in 1 entry staged for demo'],
    [2, 1, '2 changes in 1 entry staged for demo'],
    [3, 2, '3 changes in 2 entries staged for demo'],
  ])('%i changes in %i entries', (changes, entries, want) => {
    expect(pendingText(changes, entries, 'demo')).toBe(want)
  })
})

describe('plural', () => {
  it.each([
    [0, '0 unapplied changes'],
    [1, '1 unapplied change'],
    [3, '3 unapplied changes'],
  ])('%i', (n, want) => {
    expect(plural(n, 'unapplied change', 'unapplied changes')).toBe(want)
  })
})

describe('connectionStatus address', () => {
  it("is the connection's URL", () => {
    expect(connectionStatus(info).address).toBe('ldaps://samba:636')
  })
})
