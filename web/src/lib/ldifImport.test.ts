import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import {
  addFailure,
  addRequest,
  commonBase,
  defaultTarget,
  endsRun,
  failedLDIF,
  LdifSyntaxError,
  type Outcome,
  parseLDIF,
  type PlanItem,
  planImport,
  precheck,
  rebase,
} from './ldifImport'
import { SchemaIndex } from './schema'
import { directorySchema } from './schema.fixture'

const idx = new SchemaIndex(directorySchema)

const clean = `version: 1
# Export of dc=corp,dc=com
dn: ou=Staff,dc=corp,dc=com
objectClass: top
objectClass: organizationalUnit

dn: uid=mkovacs,ou=Staff,dc=corp,dc=com
# a comment inside a record
cn: Marta Kovacs


# a comment after the last record

`

describe('parseLDIF', () => {
  it('reads records separated by blank lines, skipping version and comments', () => {
    expect(parseLDIF(clean)).toStrictEqual([
      {
        line: 3,
        entry: {
          dn: 'ou=Staff,dc=corp,dc=com',
          attributes: [
            { name: 'objectClass', values: [{ text: 'top' }, { text: 'organizationalUnit' }] },
          ],
        },
      },
      {
        line: 7,
        entry: {
          dn: 'uid=mkovacs,ou=Staff,dc=corp,dc=com',
          attributes: [{ name: 'cn', values: [{ text: 'Marta Kovacs' }] }],
        },
      },
    ])
  })

  it('parses CRLF line ends and a leading BOM the same as LF', () => {
    expect(parseLDIF('\uFEFF' + clean.replaceAll('\n', '\r\n'))).toStrictEqual(parseLDIF(clean))
  })

  it('unfolds a continued line', () => {
    expect(parseLDIF('dn: cn=x\ndescription: abc\n def\n')[0].entry.attributes).toStrictEqual([
      { name: 'description', values: [{ text: 'abcdef' }] },
    ])
  })

  it('decodes base64 to text when it is UTF-8 and keeps it base64 when not', () => {
    const ldif = `dn:: dWlkPWFwZXRyb3Ysb3U9U3RhZmYsZGM9Y29ycCxkYz1jb20=
cn:: 0JDQvdC90LAg0J/QtdGC0YDQvtCy0LA=
jpegPhoto:: /9j/4AAQ
cn;lang-de: X
`
    expect(parseLDIF(ldif)[0].entry).toStrictEqual({
      dn: 'uid=apetrov,ou=Staff,dc=corp,dc=com',
      attributes: [
        { name: 'cn', values: [{ text: 'Анна Петрова' }] },
        { name: 'jpegPhoto', values: [{ text: '/9j/4AAQ', base64: true }] },
        { name: 'cn;lang-de', values: [{ text: 'X' }] },
      ],
    })
  })

  it('reads changetype: add as a content record and marks other changetypes unsupported', () => {
    const ldif = `dn: cn=a,dc=corp,dc=com
changetype: add
objectClass: device

dn: cn=b,dc=corp,dc=com
changetype: modify
replace: cn
cn: B
-
add: description
description: b
-

dn: cn=c,dc=corp,dc=com
cn: c
`
    const got = parseLDIF(ldif)
    expect(got.map((r) => [r.line, r.entry.dn, r.unsupported])).toStrictEqual([
      [1, 'cn=a,dc=corp,dc=com', undefined],
      [5, 'cn=b,dc=corp,dc=com', 'changetype: modify'],
      [14, 'cn=c,dc=corp,dc=com', undefined],
    ])
    expect(got[0]).toStrictEqual({
      line: 1,
      entry: {
        dn: 'cn=a,dc=corp,dc=com',
        attributes: [{ name: 'objectClass', values: [{ text: 'device' }] }],
      },
    })
  })

  it('marks a record with a URL value unsupported', () => {
    const [r] = parseLDIF('dn: cn=x\njpegPhoto:< file:///x.jpg\n')
    expect(r.unsupported).toBe('URL value jpegPhoto:< file:///x.jpg')
  })

  it.each([
    ['a record without dn', 'version: 1\n\ncn: x\n', 3],
    ['a line with no colon', 'dn: cn=x\nobjectClass top\n', 2],
    ['an invalid attribute name', 'dn: cn=x\nbad_name: y\n', 2],
    ['bad base64', 'dn: cn=x\ncn:: !!!\n', 2],
    ['a dn:: that is not UTF-8', 'dn:: /9j/4AAQ\n', 1],
    ['a dn: inside a record', 'dn: cn=a\ncn: a\ndn: cn=b\n', 3],
    ['an error after a folded line', 'dn: cn=x\ndescription: a\n b\nnocolon\n', 4],
  ])('throws LdifSyntaxError on %s', (_, ldif, line) => {
    let err: unknown
    try {
      parseLDIF(ldif)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LdifSyntaxError)
    expect((err as LdifSyntaxError).line).toBe(line)
    expect((err as LdifSyntaxError).message).toMatch(new RegExp(`^Line ${line}: `))
  })
})

describe('commonBase', () => {
  it('is the longest common suffix, in the first DN spelling', () => {
    expect(commonBase(['uid=a,ou=Staff,dc=corp,dc=com', 'ou=Staff,dc=corp,dc=com'])).toBe(
      'ou=Staff,dc=corp,dc=com',
    )
    expect(commonBase(['uid=a,DC=Corp, DC=com', 'uid=b,dc=corp,dc=com'])).toBe('DC=Corp,DC=com')
  })

  it('is empty for two different trees or no DNs', () => {
    expect(commonBase(['dc=corp,dc=com', 'dc=example,dc=org'])).toBe('')
    expect(commonBase([])).toBe('')
  })
})

describe('defaultTarget', () => {
  const info = { namingContexts: ['dc=example,dc=org'], baseDN: 'dc=example,dc=org' }

  it.each([
    ['a base outside the directory', 'dc=corp,dc=com', undefined, 'dc=example,dc=org'],
    [
      'a base inside a naming context',
      'ou=x,dc=example,dc=org',
      undefined,
      'ou=x,dc=example,dc=org',
    ],
    ['here', 'dc=corp,dc=com', 'ou=People,dc=example,dc=org', 'ou=People,dc=example,dc=org'],
  ])('picks the target for %s', (_, from, here, want) => {
    expect(defaultTarget(from, info, here)).toBe(want)
  })

  it('falls back to baseDN without naming contexts', () => {
    expect(defaultTarget('dc=corp,dc=com', { baseDN: 'dc=example,dc=org' })).toBe(
      'dc=example,dc=org',
    )
  })
})

describe('rebase', () => {
  it('swaps the suffix whatever its case and spacing', () => {
    expect(rebase('uid=a,DC=Corp, DC=com', 'dc=corp,dc=com', 'dc=example,dc=org')).toBe(
      'uid=a,dc=example,dc=org',
    )
  })

  it('keeps a DN outside from, and any DN when from equals to', () => {
    expect(rebase('uid=a,dc=other,dc=net', 'dc=corp,dc=com', 'dc=example,dc=org')).toBe(
      'uid=a,dc=other,dc=net',
    )
    expect(rebase('uid=a, dc=corp,dc=com', 'dc=corp,dc=com', 'DC=Corp,DC=com')).toBe(
      'uid=a, dc=corp,dc=com',
    )
  })
})

const corp = `dn: uid=mkovacs,ou=Staff,dc=corp,dc=com
objectClass: inetOrgPerson
uid: mkovacs
cn: Marta Kovacs
sn: Kovacs
userPassword: {SSHA}x2Gm9q0r
userPassword: {SSHA}aT5eB3lW
entryUUID: 6f1c0e44-2b1e-103f-9a51-cb1d4b6f2a10

dn: ou=Staff,dc=corp,dc=com
objectClass: organizationalUnit
ou: Staff
createTimestamp: 20250311094512Z
entryuuid: 7a2d1f55-2b1e-103f-9a51-cb1d4b6f2a10

dn: cn=Ops,ou=Staff,DC=Corp,DC=com
objectClass: groupOfNames
cn: Ops
member: uid=mkovacs,ou=Staff,dc=corp,dc=com
member: uid=cfo,ou=Board,dc=other,dc=net

dn: uid=old,ou=Staff,dc=corp,dc=com
changetype: delete
`

const warned = `dn: uid=jlee,ou=Staff,dc=corp,dc=com
objectClass: inetOrgPerson
cn: Jin Lee
sshPublicKey: ssh-ed25519 AAAA

dn: cn=Finance,ou=Staff,dc=corp,dc=com
objectClass: groupOfNames
cn: Finance
member: uid=jlee,ou=Staff,dc=corp,dc=com
member: uid=gone,ou=Staff,dc=corp,dc=com
member: uid=gone,ou=Staff,DC=Corp,DC=com
`

describe('planImport', () => {
  it('swaps the base, leaves out server-managed and secret attributes and puts parents first', () => {
    const at = (dn: string) => `${dn},ou=Staff,dc=example,dc=org`
    expect(planImport(parseLDIF(corp), 'dc=corp,dc=com', 'dc=example,dc=org', idx)).toEqual({
      items: [
        {
          dn: 'ou=Staff,dc=example,dc=org',
          line: 10,
          entry: {
            dn: 'ou=Staff,dc=example,dc=org',
            attributes: [
              { name: 'objectClass', values: [{ text: 'organizationalUnit' }] },
              { name: 'ou', values: [{ text: 'Staff' }] },
            ],
          },
          warnings: [],
        },
        {
          dn: at('uid=mkovacs'),
          line: 1,
          entry: {
            dn: at('uid=mkovacs'),
            attributes: [
              { name: 'objectClass', values: [{ text: 'inetOrgPerson' }] },
              { name: 'uid', values: [{ text: 'mkovacs' }] },
              { name: 'cn', values: [{ text: 'Marta Kovacs' }] },
              { name: 'sn', values: [{ text: 'Kovacs' }] },
            ],
          },
          warnings: [],
        },
        {
          dn: at('cn=Ops'),
          line: 16,
          entry: {
            dn: at('cn=Ops'),
            attributes: [
              { name: 'objectClass', values: [{ text: 'groupOfNames' }] },
              { name: 'cn', values: [{ text: 'Ops' }] },
              {
                name: 'member',
                values: [{ text: at('uid=mkovacs') }, { text: 'uid=cfo,ou=Board,dc=other,dc=net' }],
              },
            ],
          },
          warnings: [],
        },
        {
          dn: at('uid=old'),
          line: 22,
          entry: { dn: at('uid=old'), attributes: [] },
          unsupported: 'changetype: delete',
          warnings: [],
        },
      ],
      leftOut: ['createTimestamp', 'entryUUID'],
      passwords: 2,
    })
  })

  it('warns of a missing MUST, an attribute not in the schema and a member not in the file', () => {
    const [jlee, finance] = planImport(
      parseLDIF(warned),
      'dc=corp,dc=com',
      'dc=example,dc=org',
      idx,
    ).items
    expect(jlee.warnings).toStrictEqual([
      'attribute sshPublicKey not in schema',
      'missing sn, required by its object classes',
    ])
    expect(finance.warnings).toStrictEqual([
      'member outside the import: uid=gone,ou=Staff,dc=example,dc=org',
    ])
    expect(finance.entry.attributes?.at(-1)?.values).toStrictEqual([
      { text: 'uid=jlee,ou=Staff,dc=example,dc=org' },
      { text: 'uid=gone,ou=Staff,dc=example,dc=org' },
    ])
  })

  it('gives no warnings without a schema', () => {
    const plan = planImport(
      parseLDIF(warned),
      'dc=corp,dc=com',
      'dc=example,dc=org',
      new SchemaIndex(undefined),
    )
    expect(plan.items.flatMap((i) => i.warnings)).toStrictEqual([])
  })

  it('merges attribute spellings that differ only in case and drops repeated values', () => {
    const ldif = `dn: cn=x,dc=corp,dc=com
objectClass: top
objectclass: device
objectClass: device
CN: x
cn: x
cn: X
cn;lang-de: x
description:: /9j/4AAQ
Description: /9j/4AAQ
`
    expect(planImport(parseLDIF(ldif), '', '', idx).items[0].entry.attributes).toStrictEqual([
      { name: 'objectClass', values: [{ text: 'top' }, { text: 'device' }] },
      { name: 'CN', values: [{ text: 'x' }, { text: 'X' }] },
      { name: 'cn;lang-de', values: [{ text: 'x' }] },
      { name: 'description', values: [{ text: '/9j/4AAQ', base64: true }, { text: '/9j/4AAQ' }] },
    ])
  })

  it('plans an entry whose attributes are all left out', () => {
    const ldif = 'dn: cn=x,dc=corp,dc=com\nuserPassword: s\nentryUUID: u\n'
    expect(planImport(parseLDIF(ldif), 'dc=corp,dc=com', 'dc=example,dc=org', idx)).toEqual({
      items: [
        {
          dn: 'cn=x,dc=example,dc=org',
          line: 1,
          entry: { dn: 'cn=x,dc=example,dc=org', attributes: [] },
          warnings: [],
        },
      ],
      leftOut: ['entryUUID'],
      passwords: 1,
    })
  })
})

const item = (dn: string, unsupported?: string): PlanItem => ({
  dn,
  line: 1,
  entry: { dn, attributes: [{ name: 'cn', values: [{ text: 'x' }] }] },
  unsupported,
  warnings: [],
})

describe('precheck', () => {
  const failed: Outcome = { kind: 'failed', message: 'no' }
  const unsupported: Outcome = { kind: 'unsupported', reason: 'changetype: delete' }
  const notImported: Outcome = { kind: 'not-imported', reason: 'parent' }

  it('is unsupported for an unsupported item', () => {
    expect(precheck(item('cn=x,dc=corp', 'changetype: delete'), new Map())).toStrictEqual(
      unsupported,
    )
  })

  it('is not imported when a failed or unsupported DN is above the item', () => {
    for (const above of [failed, unsupported]) {
      const done = new Map([['OU=Staff,dc=corp', above]])
      expect(precheck(item('uid=a,ou=staff,dc=corp'), done)).toStrictEqual(notImported)
      expect(precheck(item('cn=b,uid=a,ou=staff,dc=corp'), done)).toStrictEqual(notImported)
    }
  })

  it('sends an item whose parent exists or was created, or whose sibling failed', () => {
    const done = new Map<string, Outcome>([
      ['ou=Staff,dc=corp', { kind: 'exists' }],
      ['ou=Board,dc=corp', { kind: 'created' }],
      ['uid=b,ou=Staff,dc=corp', failed],
    ])
    expect(precheck(item('uid=a,ou=Staff,dc=corp'), done)).toBeUndefined()
    expect(precheck(item('uid=c,ou=Board,dc=corp'), done)).toBeUndefined()
  })
})

describe('addFailure', () => {
  it('is exists for result 68 and failed with the message for another code', () => {
    const conflict = (ldapResultCode: number) =>
      new ApiError(409, { code: 'conflict', message: 'taken', ldapResultCode })
    expect(addFailure(conflict(68))).toStrictEqual({ kind: 'exists' })
    expect(addFailure(conflict(20))).toStrictEqual({ kind: 'failed', message: 'taken' })
    expect(addFailure(new Error('boom'))).toStrictEqual({ kind: 'failed', message: 'boom' })
  })
})

describe('endsRun', () => {
  it('is true for a lost token or session and false for a conflict', () => {
    expect(endsRun(new ApiError(401, { code: 'unauthorized', message: '' }))).toBe(true)
    expect(endsRun(new ApiError(401, { code: 'not_connected', message: '' }))).toBe(true)
    expect(endsRun(new ApiError(409, { code: 'conflict', message: '' }))).toBe(false)
  })

  it('is true for a lost LDAP connection and an unreachable ldaplens, false for a refusal', () => {
    expect(endsRun(new ApiError(502, { code: 'network', message: '' }))).toBe(true)
    expect(endsRun(new ApiError(0, { code: 'offline', message: '' }))).toBe(true)
    expect(endsRun(new TypeError('Failed to fetch'))).toBe(true)
    expect(endsRun(new ApiError(422, { code: 'rejected', message: '' }))).toBe(false)
    expect(endsRun(new ApiError(502, { code: 'ldap_error', message: '' }))).toBe(false)
  })
})

describe('addRequest', () => {
  it('sends text values as text and an attribute with a binary value all in base64', () => {
    const entry = {
      dn: 'uid=a,dc=corp',
      attributes: [
        { name: 'cn', values: [{ text: 'Анна' }] },
        { name: 'jpegPhoto', values: [{ text: '/9j/', base64: true }, { text: 'x' }] },
      ],
    }
    expect(addRequest({ ...item('uid=a,dc=corp'), entry })).toStrictEqual({
      dn: 'uid=a,dc=corp',
      attributes: [
        { name: 'cn', values: ['Анна'] },
        { name: 'jpegPhoto', values: ['/9j/', 'eA=='], base64: true },
      ],
    })
  })
})

describe('failedLDIF', () => {
  const plan = {
    items: [
      item('ou=A,dc=corp'),
      item('uid=a,ou=A,dc=corp'),
      item('ou=B,dc=corp'),
      item('uid=b,ou=B,dc=corp'),
    ],
    leftOut: [],
    passwords: 0,
  }

  it('holds the failed and not-imported records in plan order', () => {
    const outcomes = new Map<string, Outcome>([
      ['ou=A,dc=corp', { kind: 'created' }],
      ['uid=a,ou=A,dc=corp', { kind: 'not-imported', reason: 'stopped' }],
      ['ou=B,dc=corp', { kind: 'failed', message: 'no' }],
      ['uid=b,ou=B,dc=corp', { kind: 'not-imported', reason: 'parent' }],
    ])
    expect(failedLDIF(plan, outcomes)).toBe(`version: 1

dn: uid=a,ou=A,dc=corp
cn: x

dn: ou=B,dc=corp
cn: x

dn: uid=b,ou=B,dc=corp
cn: x
`)
  })

  it('is empty when nothing failed', () => {
    const outcomes = new Map<string, Outcome>([['ou=A,dc=corp', { kind: 'exists' }]])
    expect(failedLDIF(plan, outcomes)).toBe('')
  })
})
