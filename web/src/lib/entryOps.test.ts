import { describe, expect, it } from 'vitest'
import { applied, entryChanges, stage, type Batch } from './changes'
import { rdnValue } from './dn'
import {
  addAttributes,
  addableToForm,
  addLDIF,
  canCreate,
  canSetPassword,
  childrenNote,
  cloneForm,
  defaultRDNAttr,
  deleteLDIF,
  escapeRDNValue,
  formDN,
  formMust,
  formProblems,
  isMustRow,
  newChildForm,
  passwordProblem,
  rdnChoices,
  renameLDIF,
  renameProblem,
  renameTarget,
  stagedHint,
  stagedUnder,
  withClasses,
  type EntryForm,
} from './entryOps'
import { structuralChoices } from './edit'
import { SchemaIndex } from './schema'
import { directorySchema } from './schema.fixture'
import type { Entry } from './types'

const idx = new SchemaIndex(directorySchema)
const none = new SchemaIndex(undefined)
const OU = 'ou=e2e,dc=example,dc=org'

describe('escapeRDNValue', () => {
  it.each([
    ['Doe, John', 'Doe\\, John'],
    ['a+b', 'a\\+b'],
    [' lead', '\\ lead'],
    ['trail ', 'trail\\ '],
    ['#1', '\\#1'],
    ['say "hi" <x>; y\\z', 'say \\"hi\\" \\<x\\>\\; y\\\\z'],
    ['Jürgen', 'Jürgen'],
  ])('%s', (v, want) => {
    expect(escapeRDNValue(v)).toBe(want)
    expect(rdnValue(`cn=${want}`)).toBe(v)
  })
  it('formDN escapes the trimmed RDN value under the trimmed parent', () => {
    const f: EntryForm = {
      parent: ` ${OU} `,
      classes: [],
      rdnAttr: 'cn',
      rdnValue: ' Doe, John ',
      attrs: [],
    }
    expect(formDN(f)).toBe(`cn=Doe\\, John,${OU}`)
  })
})

describe('form defaults', () => {
  it('picks ou for an OU, uid where allowed, else cn', () => {
    expect(defaultRDNAttr(['organizationalUnit'], idx)).toBe('ou')
    expect(defaultRDNAttr(['inetOrgPerson'], idx)).toBe('uid')
    expect(defaultRDNAttr(['person'], idx)).toBe('cn')
    expect(defaultRDNAttr(['inetOrgPerson'], none)).toBe('cn')
    expect(defaultRDNAttr(['organizationalUnit'], none)).toBe('ou')
  })
  it('offers MUST and MAY names, never objectClass or a secret', () => {
    expect(rdnChoices(['organizationalUnit'], idx)).toEqual(['description', 'ou'])
    expect(rdnChoices(['inetOrgPerson'], idx)).toEqual([
      'cn',
      'description',
      'employeeNumber',
      'mail',
      'ou',
      'sn',
      'uid',
    ])
  })
  it('a new child starts empty with cn', () => {
    expect(newChildForm(OU, idx)).toEqual({
      parent: OU,
      classes: [],
      rdnAttr: 'cn',
      rdnValue: '',
      attrs: [],
    })
  })
  it('withClasses picks the RDN attribute, keeps filled rows and adds a row per MUST', () => {
    const f: EntryForm = {
      ...newChildForm(OU, idx),
      attrs: [
        { name: 'description', values: ['d'] },
        { name: 'mail', values: [''] },
      ],
    }
    expect(withClasses(f, ['inetOrgPerson'], idx)).toEqual({
      parent: OU,
      classes: ['inetOrgPerson'],
      rdnAttr: 'uid',
      rdnValue: '',
      attrs: [
        { name: 'description', values: ['d'] },
        { name: 'cn', values: [] },
        { name: 'sn', values: [] },
      ],
    })
    expect(withClasses(f, ['organizationalUnit'], idx).attrs).toEqual([
      { name: 'description', values: ['d'] },
      { name: 'ou', values: [] },
    ])
    expect(addableToForm(withClasses(f, ['inetOrgPerson'], idx), idx)).toEqual([
      'employeeNumber',
      'mail',
      'ou',
      'uid',
    ])
  })
  it('withClasses keeps a chosen RDN attribute while the classes allow it', () => {
    const f: EntryForm = {
      ...withClasses(newChildForm(OU, idx), ['inetOrgPerson'], idx),
      rdnAttr: 'cn',
    }
    const aux = withClasses(f, ['inetOrgPerson', 'shadowAccount'], idx)
    expect(aux.rdnAttr).toBe('cn')
    expect(withClasses(aux, ['organizationalUnit', 'shadowAccount'], idx).rdnAttr).toBe('ou')
  })
  it('a variant with options neither fills a MUST row nor hides its attribute', () => {
    const f: EntryForm = {
      ...newChildForm(OU, idx),
      attrs: [{ name: 'cn;lang-de', values: ['J'] }],
    }
    const person = withClasses(f, ['inetOrgPerson'], idx)
    expect(person.attrs).toEqual([
      { name: 'cn;lang-de', values: ['J'] },
      { name: 'cn', values: [] },
      { name: 'sn', values: [] },
    ])
    expect(addableToForm({ ...person, attrs: f.attrs }, idx)).toEqual([
      'cn',
      'description',
      'employeeNumber',
      'mail',
      'ou',
      'sn',
      'uid',
    ])
  })
  it('a ;binary row is the attribute itself: it fills the MUST row and leaves the list', () => {
    const pki = new SchemaIndex({
      attributeTypes: [
        ...(directorySchema.attributeTypes ?? []),
        { oid: '2.5.4.36', names: ['userCertificate'], syntax: '1.3.6.1.4.1.1466.115.121.1.8' },
      ],
      objectClasses: [
        ...(directorySchema.objectClasses ?? []),
        {
          oid: '2.5.6.15',
          names: ['strongAuthenticationUser'],
          kind: 'AUXILIARY',
          sup: ['top'],
          must: ['userCertificate'],
        },
      ],
    })
    const cert = { name: 'userCertificate;binary', values: [], binary: ['MIIB'] }
    const f: EntryForm = { ...newChildForm(OU, pki), attrs: [cert] }
    const g = withClasses(f, ['device', 'strongAuthenticationUser'], pki)
    expect(g.attrs).toEqual([cert, { name: 'cn', values: [] }])
    expect(addableToForm(g, pki)).toEqual(['description'])
  })
  it('withClasses moves a default RDN attribute to the default of the new classes', () => {
    const ou = withClasses(newChildForm(OU, idx), ['organizationalUnit'], idx)
    expect(ou.rdnAttr).toBe('ou')
    expect(withClasses(ou, ['inetOrgPerson'], idx).rdnAttr).toBe('uid')
  })
})

describe('on Active Directory', () => {
  // AD's top requires attributes the server sets, without marking them all NO-USER-MODIFICATION;
  // this fixture marks none. user allows uid, as with the RFC 2307 extensions.
  const ad = new SchemaIndex({
    attributeTypes: [
      { oid: '2.5.4.0', names: ['objectClass'] },
      { oid: '2.5.4.3', names: ['cn'] },
      { oid: '2.5.4.11', names: ['ou'] },
      { oid: '2.5.4.13', names: ['description'] },
      { oid: '0.9.2342.19200300.100.1.1', names: ['uid'] },
      { oid: '1.2.840.113556.1.2.281', names: ['nTSecurityDescriptor'] },
      { oid: '1.2.840.113556.1.4.782', names: ['objectCategory'] },
      { oid: '1.2.840.113556.1.2.1', names: ['instanceType'] },
      { oid: '1.2.840.113556.1.4.750', names: ['groupType'], singleValue: true },
    ],
    objectClasses: [
      {
        oid: '2.5.6.0',
        names: ['top'],
        kind: 'ABSTRACT',
        must: ['objectClass', 'nTSecurityDescriptor', 'objectCategory', 'instanceType'],
        may: ['description'],
      },
      {
        oid: '1.2.840.113556.1.5.8',
        names: ['group'],
        kind: 'STRUCTURAL',
        sup: ['top'],
        must: ['groupType'],
        may: ['cn'],
      },
      {
        oid: '1.2.840.113556.1.5.9',
        names: ['user'],
        kind: 'STRUCTURAL',
        sup: ['top'],
        may: ['cn', 'uid'],
      },
      {
        oid: '2.5.6.5',
        names: ['organizationalUnit'],
        kind: 'STRUCTURAL',
        sup: ['top'],
        must: ['ou'],
      },
    ],
  })
  it('names entries by cn, an OU by ou', () => {
    expect(defaultRDNAttr(['user'], ad, true)).toBe('cn')
    expect(defaultRDNAttr(['user'], ad)).toBe('uid')
    expect(defaultRDNAttr(['organizationalUnit'], ad, true)).toBe('ou')
    expect(withClasses(newChildForm(OU, ad), ['user'], ad, true).rdnAttr).toBe('cn')
  })
  it("offers none of top's MUSTs, which the server sets, as RDN or rows", () => {
    expect(rdnChoices(['user'], ad)).toEqual(['cn', 'description', 'uid'])
    expect(addableToForm(withClasses(newChildForm(OU, ad), ['user'], ad, true), ad)).toEqual([
      'cn',
      'description',
      'uid',
    ])
  })
  it("asks for the MUSTs of the classes, not top's", () => {
    const f = withClasses(newChildForm(OU, ad), ['group'], ad)
    expect(f.attrs).toEqual([{ name: 'groupType', values: [] }])
    expect([...formMust(['group'], ad)]).toEqual([ad.key('groupType')])
    const named = { ...f, rdnValue: 'Admins' }
    expect(Object.fromEntries(formProblems(named, ad))).toEqual({
      grouptype: 'Required by the object class',
    })
    expect(canCreate(named, ad)).toBe(false)
    expect(
      canCreate({ ...named, attrs: [{ name: 'groupType', values: ['-2147483646'] }] }, ad),
    ).toBe(true)
  })
  it('clones without rows for them', () => {
    const source: Entry = {
      dn: `cn=Admins,${OU}`,
      attributes: [
        { name: 'objectClass', values: [{ text: 'top' }, { text: 'group' }] },
        { name: 'cn', values: [{ text: 'Admins' }] },
        { name: 'groupType', values: [{ text: '-2147483646' }] },
      ],
    }
    expect(cloneForm(source, ad).attrs).toEqual([{ name: 'groupType', values: ['-2147483646'] }])
  })
  it('leaves OpenLDAP alone: its top requires only objectClass', () => {
    expect(formMust(['inetOrgPerson'], idx)).toEqual(new Set([idx.key('cn'), idx.key('sn')]))
  })
})

describe('cloneForm', () => {
  const source: Entry = {
    dn: `uid=src,${OU}`,
    attributes: [
      {
        name: 'objectClass',
        values: ['top', 'person', 'organizationalPerson', 'inetOrgPerson', 'posixAccount'].map(
          (text) => ({ text }),
        ),
      },
      { name: 'uid', values: [{ text: 'src' }] },
      { name: 'cn', values: [{ text: 'Src Person' }, { text: 'SRC' }] },
      { name: 'sn', values: [{ text: 'src' }] },
      { name: 'Mail', values: [{ text: 'src@example.org' }] },
      { name: 'employeeNumber', values: [{ text: '42' }] },
      { name: 'description', values: [{ text: 'two\nlines' }, { text: 'AAEC', base64: true }] },
      { name: 'uidNumber', values: [{ text: '7' }] },
      { name: 'gidNumber', values: [{ text: '7' }] },
      { name: 'homeDirectory', values: [{ text: '/home/src' }] },
      { name: 'userPassword', values: [], masked: 1 },
      { name: 'createTimestamp', values: [{ text: '20261112093000Z' }] },
    ],
  }
  it('copies what may repeat and leaves the rest out', () => {
    expect(cloneForm(source, idx)).toEqual({
      parent: OU,
      classes: ['inetOrgPerson', 'posixAccount'],
      rdnAttr: 'uid',
      rdnValue: '',
      attrs: [
        { name: 'cn', values: ['Src Person', 'SRC'] },
        { name: 'sn', values: ['src'] },
        { name: 'description', values: ['two\nlines'], binary: ['AAEC'] },
        { name: 'gidNumber', values: ['7'] },
        { name: 'homeDirectory', values: ['/home/src'] },
        { name: 'uid', values: [] },
        { name: 'uidNumber', values: [] },
      ],
    })
  })
  it('starts from the staged view of the entry', () => {
    let b: Batch = stage([], source.dn, { kind: 'add', attr: 'description', value: 'staged' })
    b = stage(b, source.dn, { kind: 'delete', attr: 'cn', value: 'SRC' })
    const f = cloneForm(applied(source, entryChanges(b, source.dn)), idx)
    expect(f.attrs.find((a) => a.name === 'cn')?.values).toEqual(['Src Person'])
    expect(f.attrs.find((a) => a.name === 'description')?.values).toEqual(['two\nlines', 'staged'])
  })
  it('spells the classes as the schema does', () => {
    const lower: Entry = {
      dn: `uid=low,${OU}`,
      attributes: [
        {
          name: 'objectClass',
          values: ['top', 'inetorgperson', 'POSIXACCOUNT'].map((text) => ({ text })),
        },
      ],
    }
    const f = cloneForm(lower, idx)
    expect(f.classes).toEqual(['inetOrgPerson', 'posixAccount'])
    expect(structuralChoices(idx, false)).toContain(f.classes[0])
  })
  it('without a schema keeps the classes as they are', () => {
    expect(cloneForm(source, none).classes).toEqual([
      'top',
      'person',
      'organizationalPerson',
      'inetOrgPerson',
      'posixAccount',
    ])
  })
  it('copies attributes with options', () => {
    const ru: Entry = {
      ...source,
      attributes: [
        ...(source.attributes ?? []),
        { name: 'description;lang-ru', values: [{ text: 'описание' }] },
      ],
    }
    expect(cloneForm(ru, idx).attrs).toContainEqual({
      name: 'description;lang-ru',
      values: ['описание'],
    })
  })
  it('copies binary values, never the identifying ones', () => {
    const photo: Entry = {
      dn: `uid=pic,${OU}`,
      attributes: [
        { name: 'objectClass', values: [{ text: 'inetOrgPerson' }] },
        { name: 'uid', values: [{ text: 'pic' }] },
        { name: 'cn', values: [{ text: 'Pic' }] },
        { name: 'sn', values: [{ text: 'pic' }] },
        { name: 'jpegPhoto', values: [{ text: '/9j/AAEC', base64: true }] },
        { name: 'objectGUID', values: [{ text: 'AAEC', base64: true, display: 'g' }] },
        { name: 'objectSid', values: [{ text: 'AQUA', base64: true, display: 'S-1-5' }] },
        { name: 'userCertificate;binary', values: [{ text: 'MIIB', base64: true }] },
        { name: 'userSMIMECertificate', values: [{ text: 'MIIC', base64: true }] },
        { name: 'mS-DS-ConsistencyGuid', values: [{ text: 'AAED', base64: true }] },
        // Not in the list: left out by its certificate syntax.
        { name: 'cACertificate;binary', values: [{ text: 'MIID', base64: true }] },
      ],
    }
    const certs = new SchemaIndex({
      ...directorySchema,
      attributeTypes: [
        ...(directorySchema.attributeTypes ?? []),
        { oid: '2.5.4.37', names: ['cACertificate'], syntax: '1.3.6.1.4.1.1466.115.121.1.8' },
      ],
    })
    expect(cloneForm(photo, certs).attrs).toEqual([
      { name: 'cn', values: ['Pic'] },
      { name: 'sn', values: ['pic'] },
      { name: 'jpegPhoto', values: [], binary: ['/9j/AAEC'] },
    ])
  })
  it('leaves authentication bindings out', () => {
    const svc: Entry = {
      dn: `uid=svc,${OU}`,
      attributes: [
        { name: 'objectClass', values: [{ text: 'inetOrgPerson' }] },
        { name: 'cn', values: [{ text: 'Svc' }] },
        { name: 'sn', values: [{ text: 'svc' }] },
        { name: 'description', values: [{ text: 'service' }] },
        { name: 'sshPublicKey', values: [{ text: 'ssh-ed25519 AAAA' }] },
        { name: 'ipaSshPubKey', values: [{ text: 'ssh-ed25519 AAAB' }] },
        { name: 'altSecurityIdentities', values: [{ text: 'X509:<I>CN=CA<S>CN=svc' }] },
        { name: 'msDS-KeyCredentialLink', values: [{ text: 'B:8:0001:CN=svc' }] },
        { name: 'servicePrincipalName', values: [{ text: 'HTTP/svc.example.org' }] },
        { name: 'krbPrincipalName', values: [{ text: 'svc@EXAMPLE.ORG' }] },
        { name: 'krbCanonicalName', values: [{ text: 'svc@EXAMPLE.ORG' }] },
        { name: 'ipaUniqueID', values: [{ text: '0a1b2c3d' }] },
      ],
    }
    expect(cloneForm(svc, idx).attrs).toEqual([
      { name: 'cn', values: ['Svc'] },
      { name: 'sn', values: ['svc'] },
      { name: 'description', values: ['service'] },
    ])
  })
})

describe('addAttributes', () => {
  const base: EntryForm = {
    parent: OU,
    classes: ['inetOrgPerson'],
    rdnAttr: 'uid',
    rdnValue: ' jd ',
    attrs: [
      { name: 'cn', values: ['John Doe', ''] },
      { name: 'sn', values: ['Doe'] },
    ],
  }
  it('sends objectClass first, the RDN attribute next, no blank values', () => {
    expect(addAttributes(base)).toEqual([
      { name: 'objectClass', values: ['inetOrgPerson'] },
      { name: 'uid', values: ['jd'] },
      { name: 'cn', values: ['John Doe'] },
      { name: 'sn', values: ['Doe'] },
    ])
  })
  it('merges the RDN value into its row once, whatever its case', () => {
    expect(addAttributes({ ...base, rdnAttr: 'CN', rdnValue: 'john doe' })[1]).toEqual({
      name: 'cn',
      values: ['John Doe'],
    })
    expect(addAttributes({ ...base, rdnAttr: 'cn', rdnValue: 'Jane' })[1]).toEqual({
      name: 'cn',
      values: ['John Doe', 'Jane'],
    })
  })
  it('merges rows of one attribute and drops rows left blank', () => {
    const attrs = [
      { name: 'description', values: ['a'] },
      { name: 'Description', values: ['b', 'a'] },
      { name: 'mail', values: [''] },
    ]
    expect(addAttributes({ ...base, rdnValue: '', attrs })).toEqual([
      { name: 'objectClass', values: ['inetOrgPerson'] },
      { name: 'description', values: ['a', 'b'] },
    ])
  })
  it('never changes the form it reads', () => {
    const f: EntryForm = structuredClone(base)
    addAttributes(f).forEach((a) => a.values.push('x'))
    expect(f.classes).toEqual(base.classes)
    expect(f.attrs).toEqual(base.attrs)
  })
  it('keeps an attribute and its variants with options apart', () => {
    const attrs = [
      { name: 'cn', values: ['John Doe'] },
      { name: 'cn;lang-de', values: ['Johann'] },
      { name: 'CN;LANG-DE', values: ['Hans'] },
    ]
    expect(addAttributes({ ...base, rdnAttr: 'cn', rdnValue: 'John Doe', attrs })).toEqual([
      { name: 'objectClass', values: ['inetOrgPerson'] },
      { name: 'cn', values: ['John Doe'] },
      { name: 'cn;lang-de', values: ['Johann', 'Hans'] },
    ])
  })
  it('sends an attribute with a binary value once, all in base64, text as UTF-8', () => {
    const attrs = [
      { name: 'jpegPhoto', values: [], binary: ['/9j/AAEC'] },
      { name: 'description', values: ['ü'], binary: ['AAEC'] },
      { name: 'Description', values: [], binary: ['AAEC'] },
    ]
    expect(addAttributes({ ...base, rdnValue: '', attrs })).toEqual([
      { name: 'objectClass', values: ['inetOrgPerson'] },
      { name: 'jpegPhoto', values: ['/9j/AAEC'], base64: true },
      { name: 'description', values: ['w7w=', 'AAEC'], base64: true },
    ])
  })
})

describe('formProblems and canCreate', () => {
  const ready: EntryForm = {
    parent: OU,
    classes: ['inetOrgPerson'],
    rdnAttr: 'uid',
    rdnValue: 'jd',
    attrs: [
      { name: 'cn', values: ['J'] },
      { name: 'sn', values: ['D'] },
    ],
  }
  it('passes a complete form', () => {
    expect(formProblems(ready, idx).size).toBe(0)
    expect(canCreate(ready, idx)).toBe(true)
  })
  it('asks for MUST values except the RDN attribute, which the RDN value fills', () => {
    const f: EntryForm = {
      ...ready,
      rdnAttr: 'cn',
      rdnValue: '',
      attrs: [
        { name: 'cn', values: [] },
        { name: 'sn', values: [] },
      ],
    }
    expect(Object.fromEntries(formProblems(f, idx))).toEqual({ sn: 'Required by the object class' })
    expect(canCreate(f, idx)).toBe(false)
  })
  it('checks values by syntax and single value, the RDN value included', () => {
    const f: EntryForm = {
      ...ready,
      classes: ['inetOrgPerson', 'posixAccount'],
      rdnAttr: 'uidNumber',
      rdnValue: '8',
      attrs: [
        ...ready.attrs,
        { name: 'uid', values: ['jd'] },
        { name: 'uidNumber', values: ['7'] },
        { name: 'gidNumber', values: ['x'] },
        { name: 'homeDirectory', values: ['/h'] },
      ],
    }
    expect(Object.fromEntries(formProblems(f, idx))).toEqual({
      uidnumber: 'Single-valued: keep one value',
      gidnumber: 'Must be an integer',
    })
  })
  it('without a schema needs only a class, an RDN and a parent', () => {
    expect(canCreate({ ...ready, attrs: [] }, none)).toBe(true)
    expect(canCreate({ ...ready, classes: [] }, none)).toBe(false)
    expect(canCreate({ ...ready, rdnValue: ' ' }, none)).toBe(false)
    expect(canCreate({ ...ready, parent: 'nope' }, none)).toBe(false)
  })
  it('refuses a secret RDN attribute, as a clone of an entry it names', () => {
    const f: EntryForm = { ...ready, rdnAttr: 'userPassword' }
    expect(formProblems(f, idx).get('userpassword')).toBe('Secret attributes cannot be edited here')
    expect(canCreate(f, idx)).toBe(false)
  })
  it('refuses a secret RDN attribute typed without a schema', () => {
    const f: EntryForm = { ...ready, rdnAttr: 'userPassword', attrs: [] }
    expect(Object.fromEntries(formProblems(f, none))).toEqual({
      userpassword: 'Secret attributes cannot be edited here',
    })
    expect(canCreate(f, none)).toBe(false)
  })
  it('takes a value of a variant with options for a MUST', () => {
    const f: EntryForm = {
      ...ready,
      attrs: [
        { name: 'cn', values: [] },
        { name: 'cn;lang-de', values: ['J'] },
        { name: 'sn', values: ['D'] },
      ],
    }
    expect(formProblems(f, idx).size).toBe(0)
  })
  it('counts binary values; a row holding only them is filled', () => {
    const f: EntryForm = {
      ...ready,
      attrs: [...ready.attrs, { name: 'description', values: [], binary: ['AAEC'] }],
    }
    expect(formProblems(f, idx).size).toBe(0)
    expect(withClasses(f, ['inetOrgPerson'], idx).attrs).toContainEqual({
      name: 'description',
      values: [],
      binary: ['AAEC'],
    })
  })
  it('a MUST row is the attribute itself, never a variant with options', () => {
    const must = formMust(['inetOrgPerson'], idx)
    expect(isMustRow('cn', must, idx)).toBe(true)
    expect(isMustRow('CN', must, idx)).toBe(true)
    expect(isMustRow('cn;lang-de', must, idx)).toBe(false)
    expect(isMustRow('description', must, idx)).toBe(false)
  })
})

describe('stagedUnder', () => {
  const batch: Batch = [
    {
      dn: `uid=a,${OU}`,
      changes: [
        { op: 'add', attr: 'mail', values: ['x'] },
        { op: 'add', attr: 'description', values: ['y'] },
      ],
    },
    {
      dn: 'uid=b,ou=other,dc=example,dc=org',
      changes: [{ op: 'add', attr: 'mail', values: ['z'] }],
    },
  ]
  it('counts staged attributes of the entry and the entries below it', () => {
    expect(stagedUnder(batch, OU)).toBe(2)
    expect(stagedUnder(batch, 'UID=A,OU=E2E,DC=example,DC=org')).toBe(2)
    expect(stagedUnder(batch, 'dc=example,dc=org')).toBe(3)
    expect(stagedUnder(batch, `uid=c,${OU}`)).toBe(0)
  })
  it('says what to do first', () => {
    expect(stagedHint(0)).toBe('')
    expect(stagedHint(1)).toBe('Apply or discard 1 staged change first')
    expect(stagedHint(3)).toBe('Apply or discard 3 staged changes first')
  })
})

describe('rename', () => {
  const dn = `uid=a,${OU}`
  it('builds the target DN', () => {
    expect(renameTarget(' uid=b ', ` ${OU} `)).toBe(`uid=b,${OU}`)
  })
  it.each([
    ['uid=b', OU, ''],
    ['uid=a', 'ou=moved,dc=example,dc=org', ''],
    ['b', OU, 'The new RDN must look like cn=Name'],
    ['uid=b,ou=x', OU, 'The new RDN must look like cn=Name'],
    ['uid=b', '', 'The new parent must be a DN'],
    ['uid=b', dn, 'An entry cannot move below itself'],
    ['uid=b', `ou=x, UID=A , ${OU}`, 'An entry cannot move below itself'],
    ['uid=a', OU.toUpperCase(), 'The new DN is the current one'],
    ['UID=A', OU, ''],
    // The new RDN value is written to the entry and the new DN is logged.
    ['userPassword=x', OU, 'userPassword is secret and cannot name an entry'],
    ['uid=b+2.5.4.35=x', OU, '2.5.4.35 is secret and cannot name an entry'],
    ['uid=b+OID.2.5.4.35=x', OU, 'OID.2.5.4.35 is secret and cannot name an entry'],
  ])('%s under %s', (rdn, parent, want) => {
    expect(renameProblem(dn, rdn, parent, idx)).toBe(want)
  })
  it('refuses a secret RDN without a schema too', () => {
    expect(renameProblem(dn, 'unicodePwd=x', OU, none)).toBe(
      'unicodePwd is secret and cannot name an entry',
    )
  })
})

describe('LDIF', () => {
  it('add, skipping an attribute name that would inject records', () => {
    const name = 'description: exported\n\ndn: cn=admin,dc=example,dc=com\nchangetype: delete\n'
    const out = addLDIF('uid=p,dc=x', [
      { name: 'cn', values: ['P'] },
      { name, values: ['x'] },
    ])
    const lines = out.split('\n')
    const dn = lines.findIndex((l) => l.startsWith('dn'))
    expect(lines.filter((l) => l.startsWith('dn'))).toHaveLength(1)
    // The record's own changetype is the only one.
    expect(lines.filter((l) => l.startsWith('changetype'))).toEqual(['changetype: add'])
    expect(lines.slice(dn, -1)).not.toContain('')
    expect(out).toContain('# invalid attribute name skipped')
  })
  it('add, with binary values as attr::', () => {
    expect(addLDIF('uid=p,dc=x', [{ name: 'jpegPhoto', values: ['/9j/AAEC'], base64: true }])).toBe(
      'version: 1\n\ndn: uid=p,dc=x\nchangetype: add\njpegPhoto:: /9j/AAEC\n',
    )
  })
  it('add, with base64 where unsafe', () => {
    const attrs = [
      { name: 'objectClass', values: ['person'] },
      { name: 'cn', values: ['Doe, John'] },
      { name: 'sn', values: ['Dö'] },
    ]
    expect(addLDIF('cn=Doe\\, John,dc=x', attrs)).toBe(
      'version: 1\n\ndn: cn=Doe\\, John,dc=x\nchangetype: add\nobjectClass: person\ncn: Doe, John\nsn:: RMO2\n',
    )
  })
  it('delete', () => {
    expect(deleteLDIF('uid=a,dc=x')).toBe('version: 1\n\ndn: uid=a,dc=x\nchangetype: delete\n')
  })
  it('modrdn, with newsuperior only for a move', () => {
    expect(renameLDIF('uid=a,dc=x', 'uid=b', undefined, true)).toBe(
      'version: 1\n\ndn: uid=a,dc=x\nchangetype: modrdn\nnewrdn: uid=b\ndeleteoldrdn: 1\n',
    )
    expect(renameLDIF('uid=a,dc=x', 'uid=a', 'ou=y,dc=x', false)).toBe(
      'version: 1\n\ndn: uid=a,dc=x\nchangetype: modrdn\nnewrdn: uid=a\ndeleteoldrdn: 0\nnewsuperior: ou=y,dc=x\n',
    )
  })
})

describe('childrenNote', () => {
  it.each([
    [0, ''],
    [1, 'Has 1 child. Delete it first.'],
    [5, 'Has 5 children. Delete them first.'],
    [101, 'Has 100+ children. Delete them first.'],
  ])('%d', (n, want) => {
    expect(childrenNote(n)).toBe(want)
  })
})

describe('passwords', () => {
  const entryOf = (classes: string[]): Entry => ({
    dn: `uid=a,${OU}`,
    attributes: [{ name: 'objectClass', values: classes.map((text) => ({ text })) }],
  })
  it('offers Set password where the classes allow userPassword', () => {
    expect(canSetPassword(entryOf(['inetOrgPerson']), idx, false)).toBe(true)
    expect(canSetPassword(entryOf(['inetOrgPerson', 'posixAccount']), idx, false)).toBe(true)
    expect(canSetPassword(entryOf(['organizationalUnit']), idx, false)).toBe(false)
    expect(canSetPassword(entryOf(['inetOrgPerson']), none, false)).toBe(false)
  })
  it('on Active Directory, for user entries only: unicodePwd is theirs', () => {
    const user = ['top', 'person', 'organizationalPerson', 'user']
    expect(canSetPassword(entryOf(user), none, true)).toBe(true)
    expect(canSetPassword(entryOf([...user, 'computer']), none, true)).toBe(true)
    // person allows userPassword, but a contact has no unicodePwd.
    expect(canSetPassword(entryOf(['top', 'person', 'contact']), idx, true)).toBe(false)
  })
  it('wants the same password typed twice, spaces and all', () => {
    expect(passwordProblem('', '')).toBe('Enter a password')
    expect(passwordProblem('a b', 'a b ')).toBe('Passwords do not match')
    expect(passwordProblem(' a b ', ' a b ')).toBe('')
  })
})
