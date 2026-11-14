import { describe, expect, it } from 'vitest'
import { view } from './changes'
import {
  addableAttributes,
  addAttributeProblem,
  auxiliaryCandidates,
  classLock,
  editorKind,
  isRDNValue,
  localInputToTime,
  lockReason,
  structuralChoices,
  structuralClass,
  timeToLocalInput,
} from './edit'
import { SchemaIndex } from './schema'
import { directorySchema } from './schema.fixture'
import type { Entry } from './types'

// The Task 3 schema and entry (changes.test.ts) plus locked types for lockReason.
const schema = new SchemaIndex({
  attributeTypes: [
    { oid: '2.5.4.3', names: ['cn'] },
    { oid: '2.5.4.4', names: ['sn'] },
    { oid: '0.9.2342.19200300.100.1.3', names: ['mail'] },
    { oid: '2.16.840.1.113730.3.1.241', names: ['displayName'], singleValue: true },
    { oid: '9.9.1', names: ['count'], syntax: '1.3.6.1.4.1.1466.115.121.1.27' },
    { oid: '9.9.2', names: ['flag'], syntax: '1.3.6.1.4.1.1466.115.121.1.7' },
    { oid: '9.9.3', names: ['boss'], syntax: '1.3.6.1.4.1.1466.115.121.1.12' },
    { oid: '9.9.4', names: ['when'], syntax: '1.3.6.1.4.1.1466.115.121.1.24' },
    { oid: '2.5.4.35', names: ['userPassword', 'pass'] },
    { oid: '2.5.18.1', names: ['createTimestamp'], usage: 'directoryOperation' },
    { oid: '9.9.5', names: ['frozen'], noUserModification: true },
  ],
  objectClasses: [
    {
      oid: '2.5.6.6',
      names: ['inetOrgPerson'],
      kind: 'STRUCTURAL',
      must: ['cn', 'sn'],
      may: ['mail', 'displayName', 'count', 'flag', 'boss', 'when'],
    },
  ],
})
const none = new SchemaIndex(undefined)
const entry: Entry = {
  dn: 'uid=a,ou=e2e,dc=example,dc=org',
  attributes: [
    { name: 'objectClass', values: [{ text: 'inetOrgPerson' }] },
    { name: 'cn', values: [{ text: 'A' }] },
    { name: 'mail', values: [{ text: 'a@x' }, { text: 'b@x' }] },
  ],
}

describe('lockReason', () => {
  it.each([
    ['objectClass', ''],
    ['userPassword', 'Secret attributes cannot be edited here'],
    ['unicodePwd', 'Secret attributes cannot be edited here'],
    ['sambaNTPassword', 'Secret attributes cannot be edited here'],
    ['sambaLMPassword', 'Secret attributes cannot be edited here'],
    ['2.5.4.35', 'Secret attributes cannot be edited here'],
    ['pass', 'Secret attributes cannot be edited here'],
    // LDAPv2 spelled OIDs as "OID.2.5.4.35"; servers still take that in a DN.
    ['OID.2.5.4.35', 'Secret attributes cannot be edited here'],
    ['oid.pass', 'Secret attributes cannot be edited here'],
    ['createTimestamp', 'Set by the server'],
    ['frozen', 'Set by the server'],
    ['cn;lang-de', ''],
    ['userPassword;lang-de', 'Secret attributes cannot be edited here'],
    ['mail', ''],
    ['Mail', ''],
  ])('%s', (attr, want) => {
    expect(lockReason(attr, schema)).toBe(want)
  })
  it('without a schema locks by name only', () => {
    expect(lockReason('userPassword', none)).toBe('Secret attributes cannot be edited here')
    expect(lockReason('createTimestamp', none)).toBe('')
    expect(lockReason('objectClass', none)).toBe('objectClass is edited only with a schema')
  })
})

describe('editorKind', () => {
  it.each([
    ['flag', 'TRUE', 'boolean'],
    ['when', '20261112093000Z', 'time'],
    ['when', '', 'time'],
    ['when', '20261112093000+0300', 'text'],
    ['boss', 'cn=x,dc=y', 'dn'],
    ['mail', 'a\nb', 'multiline'],
    ['mail', 'a@x', 'text'],
    ['unknown', 'x', 'text'],
  ])('%s %j', (attr, value, want) => {
    expect(editorKind(attr, value, schema)).toBe(want)
  })
})

describe('isRDNValue', () => {
  it('matches each pair of a multi-valued RDN by type', () => {
    expect(isRDNValue('uid=a+cn=B,dc=x', 'CN', 'B')).toBe(true)
    expect(isRDNValue('uid=a+cn=B,dc=x', 'uid', 'a')).toBe(true)
    expect(isRDNValue('uid=a+cn=B,dc=x', 'dc', 'x')).toBe(false)
    // cn;lang-de is an attribute of its own, never the RDN's cn.
    expect(isRDNValue('uid=a+cn=B,dc=x', 'cn;lang-de', 'B')).toBe(false)
  })
  it('rejects other values and escaped plus signs', () => {
    expect(isRDNValue('uid=a,dc=x', 'uid', 'b')).toBe(false)
    expect(isRDNValue('cn=a\\+b,dc=x', 'cn', 'a+b')).toBe(true)
    expect(isRDNValue('cn=a\\+b,dc=x', 'cn', 'a')).toBe(false)
  })
})

describe('GeneralizedTime and datetime-local', () => {
  it.each([
    ['20261112093000Z', '2026-11-12T09:30:00'],
    ['202611120930Z', '2026-11-12T09:30:00'],
    ['20261112093000.5Z', '2026-11-12T09:30:00'],
    ['20261112093000+0300', ''],
    ['2026111209Z', ''],
    ['', ''],
  ])('timeToLocalInput(%j)', (v, want) => {
    expect(timeToLocalInput(v)).toBe(want)
  })
  it.each([
    ['2026-11-12T09:30', '20261112093000Z'],
    ['2026-11-12T09:30:05', '20261112093005Z'],
    ['', ''],
  ])('localInputToTime(%j)', (v, want) => {
    expect(localInputToTime(v)).toBe(want)
  })
})

describe('addableAttributes', () => {
  it('lists MUST and MAY names the entry lacks, sorted', () => {
    expect(addableAttributes(entry, schema)).toEqual([
      'boss',
      'count',
      'displayName',
      'flag',
      'sn',
      'when',
    ])
  })
  it('is empty without a schema', () => {
    expect(addableAttributes(entry, none)).toEqual([])
  })
  it('follows staged classes: an added one brings its names, a deleted one takes them', () => {
    const idx = new SchemaIndex(directorySchema)
    const posix: Entry = {
      dn: entry.dn,
      attributes: [
        { name: 'objectClass', values: [{ text: 'inetOrgPerson' }, { text: 'posixAccount' }] },
        { name: 'cn', values: [{ text: 'A' }] },
        { name: 'sn', values: [{ text: 'A' }] },
      ],
    }
    const staged = (op: 'add' | 'delete', e: Entry) =>
      view(e, { dn: e.dn, changes: [{ op, attr: 'objectClass', values: ['posixAccount'] }] })
    expect(addableAttributes(staged('add', entry), idx)).toContain('loginShell')
    expect(addableAttributes(staged('delete', posix), idx)).toEqual([
      'description',
      'employeeNumber',
      'mail',
      'ou',
      'uid',
    ])
  })
})

describe('object classes', () => {
  const idx = new SchemaIndex(directorySchema)
  it('locks every class but an auxiliary one', () => {
    for (const c of ['inetOrgPerson', 'person', 'top', 'unknownClass'])
      expect(classLock(c, idx)).toBe('Structural class cannot be changed')
    expect(classLock('posixAccount', idx)).toBe('')
    expect(classLock('POSIXACCOUNT', idx)).toBe('')
  })
  it('offers the auxiliary classes the entry lacks', () => {
    expect(auxiliaryCandidates(['inetOrgPerson'], idx)).toEqual(['posixAccount', 'shadowAccount'])
    expect(auxiliaryCandidates(['inetOrgPerson', 'POSIXACCOUNT'], idx)).toEqual(['shadowAccount'])
    expect(auxiliaryCandidates([], none)).toEqual([])
  })
  it('lists structural classes, the common ones first', () => {
    expect(structuralChoices(idx, false)).toEqual([
      'inetOrgPerson',
      'organizationalUnit',
      'groupOfNames',
      'posixGroup',
      'device',
      'organizationalPerson',
      'person',
    ])
    expect(structuralChoices(idx, true)).toEqual([
      'organizationalUnit',
      'device',
      'groupOfNames',
      'inetOrgPerson',
      'organizationalPerson',
      'person',
      'posixGroup',
    ])
  })
  it('finds the structural class among its superclasses', () => {
    const chain = ['top', 'person', 'organizationalPerson', 'inetOrgPerson', 'posixAccount']
    expect(structuralClass(chain, idx)).toBe('inetOrgPerson')
    expect(structuralClass(['posixAccount', 'inetOrgPerson'], idx)).toBe('inetOrgPerson')
    expect(structuralClass(['posixAccount'], idx)).toBe('')
    expect(structuralClass(['inetOrgPerson'], none)).toBe('')
  })
})

describe('+ attribute with options', () => {
  const idx = new SchemaIndex({
    attributeTypes: [
      { oid: '2.5.4.3', names: ['cn'] },
      { oid: '2.5.4.4', names: ['sn'] },
      { oid: '2.5.4.13', names: ['description'] },
      {
        oid: '0.9.2342.19200300.100.1.60',
        names: ['jpegPhoto'],
        syntax: '1.3.6.1.4.1.1466.115.121.1.28',
      },
      { oid: '2.5.4.36', names: ['userCertificate'], syntax: '1.3.6.1.4.1.1466.115.121.1.8' },
      { oid: '2.5.4.35', names: ['userPassword'] },
    ],
    objectClasses: [
      {
        oid: '2.5.6.6',
        names: ['person'],
        kind: 'STRUCTURAL',
        must: ['cn', 'sn'],
        may: ['description', 'jpegPhoto', 'userCertificate', 'userPassword'],
      },
    ],
  })
  const p: Entry = {
    dn: 'cn=p,dc=x',
    attributes: [
      { name: 'objectClass', values: [{ text: 'person' }] },
      { name: 'cn', values: [{ text: 'p' }] },
      { name: 'sn', values: [{ text: 'p' }] },
      { name: 'description;lang-ru', values: [{ text: 'd' }] },
    ],
  }
  it('offers the names the entry lacks, a certificate with ;binary', () => {
    expect(addableAttributes(p, idx)).toEqual([
      'description',
      'jpegPhoto',
      'userCertificate;binary',
    ])
    const withCert: Entry = {
      ...p,
      attributes: [
        ...(p.attributes ?? []),
        { name: 'userCertificate;binary', values: [{ text: 'MII', base64: true }] },
      ],
    }
    expect(addableAttributes(withCert, idx)).toEqual(['description', 'jpegPhoto'])
  })
  it.each([
    ['cn;lang-de', ''],
    ['CN;Lang-DE;x-phonetic', ''],
    ['description', ''],
    ['jpegPhoto', ''],
    ['description;LANG-RU', 'description;LANG-RU is already there: add a value to it'],
    ['cn', 'cn is already there: add a value to it'],
    ['cn;range=0-10', 'Options are letters, digits and hyphens, as in cn;lang-de'],
    ['cn;lang de', 'Options are letters, digits and hyphens, as in cn;lang-de'],
    ['cn;', 'Options are letters, digits and hyphens, as in cn;lang-de'],
    ['userPassword;lang-de', 'Secret attributes cannot be edited here'],
    ['mail;lang-de', "The entry's classes do not allow mail"],
  ])('addAttributeProblem(%j)', (name, want) => {
    expect(addAttributeProblem(name, p, idx)).toBe(want)
  })
  it('takes any type without a schema, never a bad option', () => {
    expect(addAttributeProblem('mail;lang-de', p, none)).toBe('')
    expect(addAttributeProblem('mail;range=0-1', p, none)).toBe(
      'Options are letters, digits and hyphens, as in cn;lang-de',
    )
  })
})
