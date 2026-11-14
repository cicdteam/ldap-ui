import { describe, expect, it } from 'vitest'
import { SYNTAX, SchemaIndex, attrKey, attributeHelp, baseName, groupAttributes } from './schema'
import type { Attribute, Schema } from './types'

const schema: Schema = {
  attributeTypes: [
    { oid: '2.5.4.41', names: ['name'], syntax: '1.3.6.1.4.1.1466.115.121.1.15{32768}' },
    { oid: '2.5.4.3', names: ['cn', 'commonName'], sup: 'name', desc: 'Common name' },
    { oid: '2.5.4.4', names: ['sn', 'surname'], sup: 'name' },
    { oid: '0.9.2342.19200300.100.1.3', names: ['mail'], syntax: '1.3.6.1.4.1.1466.115.121.1.26' },
    { oid: '2.5.4.0', names: ['objectClass'], syntax: '1.3.6.1.4.1.1466.115.121.1.38' },
    { oid: '2.5.4.31', names: ['member'], syntax: SYNTAX.dn },
    { oid: '2.5.4.50', names: ['uniqueMember'], syntax: SYNTAX.nameAndUID },
    { oid: '0.9.2342.19200300.100.1.10', names: ['manager'], syntax: SYNTAX.dn },
    { oid: '0.9.2342.19200300.100.1.60', names: ['jpegPhoto'], syntax: SYNTAX.jpeg },
    {
      oid: '1.3.6.1.4.1.42.2.27.8.1.11',
      names: ['pwdReset'],
      syntax: SYNTAX.boolean,
      singleValue: true,
    },
    {
      oid: '2.5.18.1',
      names: ['createTimestamp'],
      syntax: SYNTAX.generalizedTime,
      usage: 'directoryOperation',
      noUserModification: true,
    },
    {
      oid: '1.2.840.113556.1.4.221',
      names: ['sAMAccountName'],
      syntax: '1.3.6.1.4.1.1466.115.121.1.15',
    },
    { oid: '9.9.9.1', names: ['loopA'], sup: 'loopB' },
    { oid: '9.9.9.2', names: ['loopB'], sup: 'loopA' },
  ],
  objectClasses: [
    { oid: '2.5.6.0', names: ['top'], kind: 'ABSTRACT', must: ['objectClass'] },
    {
      oid: '2.5.6.6',
      names: ['person'],
      kind: 'STRUCTURAL',
      sup: ['top'],
      must: ['sn', 'cn'],
      may: ['description'],
    },
    {
      oid: '2.16.840.1.113730.3.2.2',
      names: ['inetOrgPerson'],
      kind: 'STRUCTURAL',
      sup: ['person'],
      may: ['mail', 'jpegPhoto', 'manager'],
    },
    {
      oid: '1.2.840.113556.1.5.9',
      names: ['user'],
      kind: 'STRUCTURAL',
      sup: ['top'],
      may: ['mail'],
    },
    { oid: '9.9.9.9', names: ['adAux'], kind: 'AUXILIARY', must: ['sAMAccountName'] },
  ],
  contentRules: [{ oid: '1.2.840.113556.1.5.9', aux: ['adAux'], may: ['manager'] }],
}

const idx = new SchemaIndex(schema)

describe('lookup', () => {
  it('finds attributes by any name, OID or with options', () => {
    expect(idx.attr('commonName')?.oid).toBe('2.5.4.3')
    expect(idx.attr('CN;lang-en')?.oid).toBe('2.5.4.3')
    expect(idx.attr('2.5.4.3')?.oid).toBe('2.5.4.3')
    expect(idx.key('commonName')).toBe(idx.key('cn'))
    expect(idx.key('unknownAttr;binary')).toBe('unknownattr')
    expect(baseName('member;range=0-1499')).toBe('member')
  })

  it('lists names for completion', () => {
    expect(idx.attrNames).toContain('commonName')
    expect(idx.classNames).toEqual(['adAux', 'inetOrgPerson', 'person', 'top', 'user'])
  })

  it('resolves syntax through SUP and drops length bounds', () => {
    expect(idx.syntax('cn')).toBe('1.3.6.1.4.1.1466.115.121.1.15')
    expect(idx.syntax('loopA')).toBe('')
  })

  it('classifies attributes', () => {
    expect(idx.isDN('member')).toBe(true)
    expect(idx.isDN('uniqueMember')).toBe(true)
    expect(idx.isDN('mail')).toBe(false)
    expect(idx.isImage('jpegPhoto')).toBe(true)
    expect(idx.isBoolean('pwdReset')).toBe(true)
    expect(idx.isOperational('createTimestamp')).toBe(true)
    expect(idx.isOperational('cn')).toBe(false)
  })

  it('falls back to well-known names without a schema', () => {
    const none = new SchemaIndex(undefined)
    expect(none.available).toBe(false)
    expect(none.isDN('memberOf')).toBe(true)
    expect(none.isDN('mail')).toBe(false)
    expect(none.isImage('thumbnailPhoto')).toBe(true)
  })
})

describe('allowed', () => {
  it('walks SUP chains', () => {
    const { must, may } = idx.allowed(['inetOrgPerson'])
    expect([...must].sort()).toEqual([idx.key('cn'), idx.key('objectClass'), idx.key('sn')].sort())
    expect(may.has(idx.key('mail'))).toBe(true)
    expect(may.has(idx.key('description'))).toBe(true)
    expect(may.has(idx.key('cn'))).toBe(false)
  })

  it('applies AD content rules; aux classes are optional', () => {
    const { must, may } = idx.allowed(['top', 'user'])
    expect(must.has(idx.key('sAMAccountName'))).toBe(false)
    expect(may.has(idx.key('sAMAccountName'))).toBe(true)
    expect(may.has(idx.key('manager'))).toBe(true)
  })
})

describe('groupAttributes', () => {
  const attrs: Attribute[] = [
    { name: 'mail', values: [{ text: 'a@x' }] },
    { name: 'createTimestamp', values: [{ text: '20260101000000Z' }] },
    {
      name: 'objectClass',
      values: [{ text: 'top' }, { text: 'person' }, { text: 'inetOrgPerson' }],
    },
    { name: 'cn', values: [{ text: 'a' }] },
    { name: 'sn', values: [{ text: 'b' }] },
    { name: 'entryUUID', values: [{ text: 'u' }] },
  ]

  it('splits into MUST, MAY and operational, objectClass first', () => {
    const g = groupAttributes(attrs, idx)
    expect(g.must.map((a) => a.name)).toEqual(['objectClass', 'cn', 'sn'])
    expect(g.may.map((a) => a.name)).toEqual(['mail'])
    expect(g.operational.map((a) => a.name)).toEqual(['createTimestamp', 'entryUUID'])
  })

  it('puts everything in MAY without a schema', () => {
    const g = groupAttributes(attrs, new SchemaIndex(undefined))
    expect(g.must).toEqual([])
    expect(g.operational).toEqual([])
    expect(g.may.map((a) => a.name)).toEqual([
      'objectClass',
      'cn',
      'createTimestamp',
      'entryUUID',
      'mail',
      'sn',
    ])
  })
})

describe('attributeHelp', () => {
  it('describes the attribute', () => {
    expect(attributeHelp('cn', idx)).toBe(
      'cn: Common name\nOID 2.5.4.3, syntax 1.3.6.1.4.1.1466.115.121.1.15',
    )
    expect(attributeHelp('pwdReset', idx)).toBe(
      'pwdReset\nOID 1.3.6.1.4.1.42.2.27.8.1.11, syntax 1.3.6.1.4.1.1466.115.121.1.7, single-value',
    )
    expect(attributeHelp('nope', idx)).toBe('nope: not in the schema')
  })
})

describe('attrKey', () => {
  it.each([
    ['cn', 'cn'],
    ['CN', 'cn'],
    ['cn;Lang-DE', 'cn;lang-de'],
    ['cn;x-b;lang-de', 'cn;lang-de;x-b'],
    ['member;range=0-1499', 'member'],
    ['member;Range=1500-*;x-a', 'member;x-a'],
    ['userCertificate;binary', 'usercertificate;binary'],
  ])('%s', (name, want) => {
    expect(attrKey(name)).toBe(want)
  })
})
