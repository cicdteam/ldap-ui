import { describe, expect, it } from 'vitest'
import { LdifSyntaxError, parseLDIF } from './ldifImport'

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
