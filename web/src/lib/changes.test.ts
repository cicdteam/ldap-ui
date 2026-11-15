import { describe, expect, it } from 'vitest'
import {
  applied,
  dropEntry,
  dropStale,
  entryChanges,
  invalidBatch,
  missingMust,
  stage,
  toLDIF,
  touchedAttributes,
  validate,
  view,
  type Batch,
  type Edit,
  type MarkedValue,
} from './changes'
import { SchemaIndex } from './schema'
import { directorySchema } from './schema.fixture'
import type { Entry, Schema } from './types'

const DN = 'uid=a,ou=e2e,dc=example,dc=org'
const entry: Entry = {
  dn: DN,
  attributes: [
    { name: 'objectClass', values: [{ text: 'inetOrgPerson' }] },
    { name: 'cn', values: [{ text: 'A' }] },
    { name: 'mail', values: [{ text: 'a@x' }, { text: 'b@x' }] },
  ],
}
const marks = (e: Entry, attr: string) =>
  (e.attributes ?? [])
    .find((a) => a.name.toLowerCase() === attr.toLowerCase())
    ?.values?.map((v) => `${v.text}:${(v as MarkedValue).mark ?? ''}`)

describe('stage', () => {
  it('replace is delete then add', () => {
    const b = stage([], DN, { kind: 'replace', attr: 'mail', from: 'a@x', to: 'c@x' })
    expect(b).toEqual([
      {
        dn: DN,
        changes: [
          { op: 'delete', attr: 'mail', values: ['a@x'] },
          { op: 'add', attr: 'mail', values: ['c@x'] },
        ],
      },
    ])
  })
  it('add then delete of the same value cancels and drops the entry', () => {
    let b = stage([], DN, { kind: 'add', attr: 'mail', value: 'z@x' })
    b = stage(b, DN, { kind: 'delete', attr: 'MAIL', value: 'z@x' })
    expect(b).toEqual([])
  })
  it('delete then re-add cancels', () => {
    let b = stage([], DN, { kind: 'delete', attr: 'mail', value: 'a@x' })
    b = stage(b, DN, { kind: 'add', attr: 'mail', value: 'a@x' })
    expect(b).toEqual([])
  })
  it('replace back to the original cancels', () => {
    let b = stage([], DN, { kind: 'replace', attr: 'mail', from: 'a@x', to: 'c@x' })
    b = stage(b, DN, { kind: 'replace', attr: 'mail', from: 'c@x', to: 'a@x' })
    expect(b).toEqual([])
  })
  it('a no-op edit returns the same batch', () => {
    const b = stage([], DN, { kind: 'add', attr: 'mail', value: 'z@x' })
    expect(stage(b, DN, { kind: 'add', attr: 'MAIL', value: 'z@x' })).toBe(b)
    const d = stage([], DN, { kind: 'delete', attr: 'mail', value: 'a@x' })
    expect(stage(d, DN, { kind: 'delete', attr: 'mail', value: 'a@x' })).toBe(d)
  })
  it('same DN in another spelling is the same entry', () => {
    let b = stage([], DN, { kind: 'add', attr: 'mail', value: 'z@x' })
    b = stage(b, 'UID=a,OU=e2e,DC=example,DC=org', { kind: 'add', attr: 'mail', value: 'y@x' })
    expect(b).toHaveLength(1)
    expect(b[0].changes).toEqual([{ op: 'add', attr: 'mail', values: ['z@x', 'y@x'] }])
  })
  it('does not mutate its input', () => {
    const b: Batch = stage([], DN, { kind: 'add', attr: 'mail', value: 'z@x' })
    const copy = JSON.parse(JSON.stringify(b))
    stage(b, DN, { kind: 'add', attr: 'mail', value: 'y@x' })
    expect(b).toEqual(copy)
  })
  it('keeps entry order and counts touched attributes', () => {
    let b = stage([], DN, { kind: 'add', attr: 'mail', value: 'z@x' })
    b = stage(b, 'uid=b,dc=x', { kind: 'add', attr: 'cn', value: 'B' })
    b = stage(b, DN, { kind: 'add', attr: 'description', value: 'd' })
    expect(b.map((e) => e.dn)).toEqual([DN, 'uid=b,dc=x'])
    expect(touchedAttributes(b)).toBe(3)
    expect(entryChanges(b, 'UID=b,dc=x')?.dn).toBe('uid=b,dc=x')
    expect(dropEntry(b, DN).map((e) => e.dn)).toEqual(['uid=b,dc=x'])
  })
  it('a truncated attribute stages only value adds and deletes', () => {
    // The inspector holds only the first values: a replace of the attribute would drop the rest.
    const big: Entry = {
      dn: DN,
      attributes: [{ name: 'member', truncated: true, values: [{ text: 'a' }, { text: 'b' }] }],
    }
    let b = stage([], big.dn, { kind: 'add', attr: 'member', value: 'c' })
    b = stage(b, big.dn, { kind: 'delete', attr: 'member', value: 'a' })
    b = stage(b, big.dn, { kind: 'replace', attr: 'member', from: 'b', to: 'd' })
    expect(entryChanges(b, big.dn)?.changes).toEqual([
      { op: 'delete', attr: 'member', values: ['a', 'b'] },
      { op: 'add', attr: 'member', values: ['c', 'd'] },
    ])
  })
})

describe('view', () => {
  it('marks deleted, changed, added and new attributes', () => {
    let b = stage([], DN, { kind: 'replace', attr: 'Mail', from: 'a@x', to: 'c@x' })
    b = stage(b, DN, { kind: 'add', attr: 'description', value: 'd' })
    const v = view(entry, entryChanges(b, DN))
    expect(marks(v, 'mail')).toEqual(['a@x:deleted', 'b@x:', 'c@x:changed'])
    expect(marks(v, 'description')).toEqual(['d:added'])
    expect(marks(entry, 'mail')).toEqual(['a@x:', 'b@x:'])
  })
  it('marks stale edits after the entry changed', () => {
    let b = stage([], DN, { kind: 'delete', attr: 'mail', value: 'gone@x' })
    b = stage(b, DN, { kind: 'add', attr: 'mail', value: 'b@x' })
    const v = view(entry, entryChanges(b, DN))
    expect(marks(v, 'mail')).toEqual(['a@x:', 'b@x:stale', 'gone@x:stale'])
    expect(dropStale(b, entry)).toEqual([])
  })
  it('drops only stale edits, and keeps the batch identity when none is stale', () => {
    const fresh = stage([], DN, { kind: 'replace', attr: 'mail', from: 'a@x', to: 'c@x' })
    // The UI reads "has stale marks" as dropStale(batch, entry) !== batch.
    expect(dropStale(fresh, entry)).toBe(fresh)
    const b = stage(fresh, DN, { kind: 'delete', attr: 'cn', value: 'gone' })
    expect(dropStale(b, entry)).toEqual(fresh)
  })
  it('applies the same marks to an attribute the entry no longer has', () => {
    const b = stage([], DN, { kind: 'replace', attr: 'title', from: 'old', to: 'new' })
    expect(marks(view(entry, entryChanges(b, DN)), 'title')).toEqual(['old:stale', 'new:changed'])
  })
})

describe('toLDIF', () => {
  it('is empty for an empty batch', () => {
    expect(toLDIF([])).toBe('')
  })
  it('skips an attribute name that would inject records', () => {
    const attr = 'description: exported\n\ndn: cn=admin,dc=example,dc=com\nchangetype: delete\n'
    let b = stage([], DN, { kind: 'add', attr, value: 'x' })
    b = stage(b, DN, { kind: 'add', attr: 'mail', value: 'm@x' })
    const out = toLDIF(b)
    const lines = out.split('\n')
    const dn = lines.findIndex((l) => l.startsWith('dn'))
    expect(lines.filter((l) => l.startsWith('dn'))).toHaveLength(1)
    // The record's own changetype is the only one.
    expect(lines.filter((l) => l.startsWith('changetype'))).toEqual(['changetype: modify'])
    expect(lines.slice(dn, -1)).not.toContain('')
    expect(out).toContain('# invalid attribute name skipped')
    // The valid change survives whole.
    expect(out).toContain('add: mail\nmail: m@x\n-\n')
    // Every '-' closes an op block: one without its op line makes ldapmodify reject the record.
    let inOp = false
    for (const l of lines) {
      if (l === '-') expect(inOp, "'-' without an op line").toBe(true)
      inOp = /^(add|delete|replace): /.test(l) || (inOp && l !== '-')
    }
  })
  it('writes delete and add blocks, base64 where unsafe, folded', () => {
    let b = stage([], DN, { kind: 'replace', attr: 'mail', from: 'a@x', to: 'ü@x' })
    b = stage(b, 'uid=b,dc=x', { kind: 'add', attr: 'description', value: ' lead' })
    b = stage(b, 'uid=b,dc=x', { kind: 'add', attr: 'cn', value: 'x'.repeat(100) })
    expect(toLDIF(b)).toBe(
      [
        'version: 1',
        '',
        `dn: ${DN}`,
        'changetype: modify',
        'delete: mail',
        'mail: a@x',
        '-',
        'add: mail',
        'mail:: w7xAeA==',
        '-',
        '',
        'dn: uid=b,dc=x',
        'changetype: modify',
        'add: description',
        'description:: IGxlYWQ=',
        '-',
        'add: cn',
        'cn: ' + 'x'.repeat(72),
        ' ' + 'x'.repeat(28),
        '-',
        '',
      ].join('\n'),
    )
  })
})

const schemaJSON: Schema = {
  attributeTypes: [
    { oid: '2.5.4.3', names: ['cn'] },
    { oid: '2.5.4.4', names: ['sn'] },
    { oid: '0.9.2342.19200300.100.1.3', names: ['mail'] },
    { oid: '2.16.840.1.113730.3.1.241', names: ['displayName'], singleValue: true },
    { oid: '9.9.1', names: ['count'], syntax: '1.3.6.1.4.1.1466.115.121.1.27' },
    { oid: '9.9.2', names: ['flag'], syntax: '1.3.6.1.4.1.1466.115.121.1.7' },
    { oid: '9.9.3', names: ['boss'], syntax: '1.3.6.1.4.1.1466.115.121.1.12' },
    { oid: '9.9.4', names: ['when'], syntax: '1.3.6.1.4.1.1466.115.121.1.24' },
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
}

describe('validate', () => {
  const idx = new SchemaIndex(schemaJSON)
  const check = (edits: Parameters<typeof stage>[2][]) => {
    let b: Batch = []
    for (const e of edits) b = stage(b, DN, e)
    return Object.fromEntries(validate(entry, entryChanges(b, DN), idx))
  }
  it('passes a clean change', () => {
    expect(check([{ kind: 'replace', attr: 'mail', from: 'a@x', to: 'c@x' }])).toEqual({})
  })
  it('flags each rule', () => {
    expect(
      check([
        { kind: 'add', attr: 'displayName', value: 'A' },
        { kind: 'add', attr: 'displayName', value: 'B' },
        { kind: 'add', attr: 'count', value: '1x' },
        { kind: 'add', attr: 'flag', value: 'yes' },
        { kind: 'add', attr: 'boss', value: 'not a dn' },
        { kind: 'add', attr: 'when', value: '2026-11-12' },
        { kind: 'delete', attr: 'cn', value: 'A' },
      ]),
    ).toEqual({
      displayname: 'Single-valued: keep one value',
      count: 'Must be an integer',
      flag: 'Must be TRUE or FALSE',
      boss: 'Not a valid DN',
      when: 'Must be a GeneralizedTime like 20261112093000Z',
      cn: 'Required by the object class',
    })
  })
  it('accepts valid syntax values', () => {
    expect(
      check([
        { kind: 'add', attr: 'count', value: '-42' },
        { kind: 'add', attr: 'flag', value: 'TRUE' },
        { kind: 'add', attr: 'boss', value: 'cn=Doe\\, John,ou=people,dc=example,dc=org' },
        { kind: 'add', attr: 'when', value: '20261112093000Z' },
      ]),
    ).toEqual({})
  })
  it('without a schema only checks for empty values', () => {
    let b: Batch = stage([], DN, { kind: 'add', attr: 'count', value: 'x' })
    b = stage(b, DN, { kind: 'delete', attr: 'cn', value: 'A' })
    expect(
      Object.fromEntries(validate(entry, entryChanges(b, DN), new SchemaIndex(undefined))),
    ).toEqual({})
  })
  it('counts a stale add of an existing value once', () => {
    const e: Entry = {
      dn: DN,
      attributes: [...(entry.attributes ?? []), { name: 'displayName', values: [{ text: 'A' }] }],
    }
    const b = stage([], DN, { kind: 'add', attr: 'displayName', value: 'A' })
    expect(Object.fromEntries(validate(e, entryChanges(b, DN), idx))).toEqual({})
  })
  it('reports the first failing rule in the listed order', () => {
    const ec = { dn: DN, changes: [{ op: 'add' as const, attr: 'count', values: ['1x', ''] }] }
    expect(Object.fromEntries(validate(entry, ec, idx))).toEqual({
      count: 'Empty values are not allowed',
    })
  })
})

describe('invalidBatch', () => {
  const idx = new SchemaIndex(schemaJSON)
  const bad = stage([], DN.toUpperCase(), { kind: 'delete', attr: 'cn', value: 'A' })
  it('validates staged entries found in the cache, whatever the DN spelling', () => {
    expect(invalidBatch(bad, [entry], idx)).toBe(true)
  })
  it('skips entries not in the cache', () => {
    expect(invalidBatch(bad, [], idx)).toBe(false)
  })
  it('passes valid changes', () => {
    const b = stage([], DN, { kind: 'add', attr: 'mail', value: 'c@x' })
    expect(invalidBatch(b, [entry], idx)).toBe(false)
  })
})

describe('applied', () => {
  it('is the entry once the batch applies: deletes gone, adds in, empty attributes dropped', () => {
    let b: Batch = stage([], DN, { kind: 'delete', attr: 'cn', value: 'A' })
    b = stage(b, DN, { kind: 'replace', attr: 'mail', from: 'a@x', to: 'c@x' })
    b = stage(b, DN, { kind: 'add', attr: 'displayName', value: 'D' })
    expect(applied(entry, entryChanges(b, DN))).toEqual({
      dn: DN,
      attributes: [
        { name: 'objectClass', values: [{ text: 'inetOrgPerson' }] },
        { name: 'mail', values: [{ text: 'b@x' }, { text: 'c@x' }] },
        { name: 'displayName', values: [{ text: 'D' }] },
      ],
    })
  })
})

describe('validate with object class changes', () => {
  const idx = new SchemaIndex(directorySchema)
  const PDN = 'uid=p,ou=e2e,dc=example,dc=org'
  const person: Entry = {
    dn: PDN,
    attributes: [
      { name: 'objectClass', values: [{ text: 'inetOrgPerson' }] },
      { name: 'uid', values: [{ text: 'p' }] },
      { name: 'cn', values: [{ text: 'P' }] },
      { name: 'sn', values: [{ text: 'p' }] },
    ],
  }
  const check = (e: Entry, edits: Edit[]) => {
    let b: Batch = []
    for (const x of edits) b = stage(b, e.dn, x)
    return Object.fromEntries(validate(e, entryChanges(b, e.dn), idx))
  }
  const posix: Edit = { kind: 'add', attr: 'objectClass', value: 'posixAccount' }
  const required = 'Required by the object class'

  it('an added class asks for its MUST attributes', () => {
    expect(check(person, [posix])).toEqual({
      uidnumber: required,
      gidnumber: required,
      homedirectory: required,
    })
    expect(
      check(person, [
        posix,
        { kind: 'add', attr: 'uidNumber', value: '7' },
        { kind: 'add', attr: 'gidNumber', value: '7' },
        { kind: 'add', attr: 'homeDirectory', value: '/home/p' },
      ]),
    ).toEqual({})
  })
  it("checks an added class's attributes by its rules", () => {
    expect(
      check(person, [
        posix,
        { kind: 'add', attr: 'uidNumber', value: 'x' },
        { kind: 'add', attr: 'gidNumber', value: '7' },
        { kind: 'add', attr: 'homeDirectory', value: '/home/p' },
      ]),
    ).toEqual({ uidnumber: 'Must be an integer' })
  })
  const withPosix: Entry = {
    dn: PDN,
    attributes: [
      { name: 'objectClass', values: [{ text: 'inetOrgPerson' }, { text: 'posixAccount' }] },
      ...(person.attributes ?? []).slice(1),
      { name: 'uidNumber', values: [{ text: '7' }] },
      { name: 'gidNumber', values: [{ text: '7' }] },
      { name: 'homeDirectory', values: [{ text: '/h' }] },
      { name: 'loginShell', values: [{ text: '/bin/sh' }] },
      { name: 'description', values: [{ text: 'd' }] },
    ],
  }
  const drop: Edit = { kind: 'delete', attr: 'objectClass', value: 'posixAccount' }

  it('a removed class flags the attributes no remaining class allows', () => {
    const gone = 'Not allowed without posixAccount; delete it'
    // uid, cn and description stay allowed through inetOrgPerson's chain.
    expect(check(withPosix, [drop])).toEqual({
      uidnumber: gone,
      gidnumber: gone,
      homedirectory: gone,
      loginshell: gone,
    })
    expect(
      check(withPosix, [
        drop,
        { kind: 'delete', attr: 'uidNumber', value: '7' },
        { kind: 'delete', attr: 'gidNumber', value: '7' },
        { kind: 'delete', attr: 'homeDirectory', value: '/h' },
        { kind: 'delete', attr: 'loginShell', value: '/bin/sh' },
      ]),
    ).toEqual({})
  })
  it('a removed class flags nothing while extensibleObject stays', () => {
    const open: Entry = {
      ...withPosix,
      attributes: [
        {
          name: 'objectClass',
          values: [
            { text: 'inetOrgPerson' },
            { text: 'posixAccount' },
            { text: 'EXTENSIBLEOBJECT' },
          ],
        },
        ...(withPosix.attributes ?? []).slice(1),
      ],
    }
    expect(check(open, [drop])).toEqual({})
  })
  it('missingMust asks only for the MUSTs the staged classes add, while objectClass is touched', () => {
    // sn stands for a MUST the original classes already had that the read does not return
    // (AD's nTSecurityDescriptor on top): never reported.
    const noSn: Entry = {
      dn: PDN,
      attributes: (person.attributes ?? []).filter((a) => a.name !== 'sn'),
    }
    expect(missingMust(noSn, undefined, idx)).toEqual([])
    const posixOn = entryChanges(stage([], PDN, posix), PDN)
    expect(missingMust(noSn, posixOn, idx)).toEqual(['uidNumber', 'gidNumber', 'homeDirectory'])
    expect(check(noSn, [posix])).toEqual({
      uidnumber: required,
      gidnumber: required,
      homedirectory: required,
    })
    const noSnUid: Entry = {
      dn: PDN,
      attributes: (noSn.attributes ?? []).filter((a) => a.name !== 'uid'),
    }
    const shadow = stage([], PDN, { kind: 'add', attr: 'objectClass', value: 'shadowAccount' })
    expect(missingMust(noSnUid, entryChanges(shadow, PDN), idx)).toEqual(['uid'])
    expect(missingMust(noSn, posixOn, new SchemaIndex(undefined))).toEqual([])
  })
})

describe('attributes with options', () => {
  const idx = new SchemaIndex(schemaJSON)
  const de: Entry = {
    dn: DN,
    attributes: [...(entry.attributes ?? []), { name: 'cn;lang-de', values: [{ text: 'A de' }] }],
  }
  it('stages cn and cn;lang-de apart, keeping the first spelling of each', () => {
    let b = stage([], DN, { kind: 'replace', attr: 'cn;lang-de', from: 'A de', to: 'B de' })
    b = stage(b, DN, { kind: 'add', attr: 'cn', value: 'B' })
    b = stage(b, DN, { kind: 'add', attr: 'CN;LANG-DE', value: 'C de' })
    expect(b[0].changes).toEqual([
      { op: 'delete', attr: 'cn;lang-de', values: ['A de'] },
      { op: 'add', attr: 'cn;lang-de', values: ['B de', 'C de'] },
      { op: 'add', attr: 'cn', values: ['B'] },
    ])
    expect(touchedAttributes(b)).toBe(2)
    const v = view(de, entryChanges(b, DN))
    expect(marks(v, 'cn')).toEqual(['A:', 'B:added'])
    expect(marks(v, 'cn;lang-de')).toEqual(['A de:deleted', 'B de:changed', 'C de:changed'])
    expect(dropStale(b, de)).toBe(b)
  })
  it('keys problems by attrKey; a MUST is met by a variant with options', () => {
    const drop = stage([], DN, { kind: 'delete', attr: 'cn', value: 'A' })
    expect(Object.fromEntries(validate(de, entryChanges(drop, DN), idx))).toEqual({})
    expect(Object.fromEntries(validate(entry, entryChanges(drop, DN), idx))).toEqual({
      cn: 'Required by the object class',
    })
    const both = stage(drop, DN, { kind: 'delete', attr: 'cn;lang-de', value: 'A de' })
    expect(Object.fromEntries(validate(de, entryChanges(both, DN), idx))).toEqual({
      cn: 'Required by the object class',
      'cn;lang-de': 'Required by the object class',
    })
  })
})

describe('binary values', () => {
  const PHOTO = '/9j/AAEC'
  const NEW = '/9j/AwQF'
  const pe: Entry = {
    dn: DN,
    attributes: [
      ...(entry.attributes ?? []),
      { name: 'jpegPhoto', values: [{ text: PHOTO, base64: true }] },
      { name: 'description', values: [{ text: 'AAEC' }] },
      { name: 'userPassword', values: [], masked: 1 },
    ],
  }
  it('stages base64 values in operations of their own, apart from text', () => {
    let b = stage([], DN, { kind: 'delete', attr: 'jpegPhoto', value: PHOTO, base64: true })
    b = stage(b, DN, { kind: 'add', attr: 'jpegPhoto', value: NEW, base64: true })
    b = stage(b, DN, { kind: 'add', attr: 'description', value: 'AAEC', base64: true })
    // Text "AAEC" is not base64 "AAEC": this delete does not cancel the add above.
    b = stage(b, DN, { kind: 'delete', attr: 'description', value: 'AAEC' })
    expect(b[0].changes).toEqual([
      { op: 'delete', attr: 'jpegPhoto', values: [PHOTO], base64: true },
      { op: 'add', attr: 'jpegPhoto', values: [NEW], base64: true },
      { op: 'delete', attr: 'description', values: ['AAEC'] },
      { op: 'add', attr: 'description', values: ['AAEC'], base64: true },
    ])
  })
  it('marks base64 values by text and encoding; a new file is added, not changed', () => {
    let b = stage([], DN, { kind: 'delete', attr: 'jpegPhoto', value: PHOTO, base64: true })
    b = stage(b, DN, { kind: 'add', attr: 'jpegPhoto', value: NEW, base64: true })
    b = stage(b, DN, { kind: 'delete', attr: 'description', value: 'AAEC', base64: true })
    const v = view(pe, entryChanges(b, DN))
    expect(marks(v, 'jpegPhoto')).toEqual([`${PHOTO}:deleted`, `${NEW}:added`])
    expect(v.attributes?.find((a) => a.name === 'jpegPhoto')?.values?.[1].base64).toBe(true)
    expect(marks(v, 'description')).toEqual(['AAEC:', 'AAEC:stale'])
  })
  it('applies, drops stale and takes back base64 values like text', () => {
    let b = stage([], DN, { kind: 'delete', attr: 'jpegPhoto', value: PHOTO, base64: true })
    b = stage(b, DN, { kind: 'add', attr: 'jpegPhoto', value: NEW, base64: true })
    const after = applied(pe, entryChanges(b, DN))
    expect(after.attributes?.find((a) => a.name === 'jpegPhoto')).toEqual({
      name: 'jpegPhoto',
      values: [{ text: NEW, base64: true }],
    })
    // A masked attribute keeps its count, no values.
    expect(after.attributes?.find((a) => a.name === 'userPassword')).toEqual({
      name: 'userPassword',
      values: [],
      masked: 1,
    })
    expect(dropStale(b, pe)).toBe(b)
    // Someone else removed the photo: its delete is stale; dropping it keeps the upload.
    const gone: Entry = { dn: DN, attributes: entry.attributes }
    expect(dropStale(b, gone)[0].changes).toEqual([
      { op: 'add', attr: 'jpegPhoto', values: [NEW], base64: true },
    ])
    const up = stage([], DN, { kind: 'add', attr: 'jpegPhoto', value: NEW, base64: true })
    expect(stage(up, DN, { kind: 'delete', attr: 'jpegPhoto', value: NEW, base64: true })).toEqual(
      [],
    )
  })
  it('writes base64 values to LDIF as attr:: as they are', () => {
    const b = stage([], DN, { kind: 'add', attr: 'jpegPhoto', value: NEW, base64: true })
    expect(toLDIF(b)).toBe(
      [
        'version: 1',
        '',
        `dn: ${DN}`,
        'changetype: modify',
        'add: jpegPhoto',
        `jpegPhoto:: ${NEW}`,
        '-',
        '',
      ].join('\n'),
    )
  })
})
