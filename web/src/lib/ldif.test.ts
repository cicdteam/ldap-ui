import { describe, expect, it } from 'vitest'
import {
  base64UTF8,
  entriesToLDIF,
  entryToLDIF,
  fold,
  isAttrDescription,
  isSafe,
  ldifPreview,
} from './ldif'

describe('isSafe', () => {
  it.each([
    ['plain', true],
    ['', true],
    [' leading space', false],
    [':colon', false],
    ['<less', false],
    ['trailing ', false],
    ['line\nbreak', false],
    ['Jürgen', false],
  ])('%j', (s, want) => {
    expect(isSafe(s)).toBe(want)
  })
})

describe('isAttrDescription', () => {
  it.each([
    ['cn', true],
    ['cn;lang-de', true],
    ['userCertificate;binary', true],
    ['member;range=0-1499', true],
    ['member;range=1500-*', true],
    ['2.5.4.3', true],
    ['msDS-KeyCredentialLink', true],
    ['', false],
    ['description\n\ndn: cn=admin', false],
    ['a b', false],
    ['cn:', false],
    ['1cn', false],
    ['cn;', false],
    ['cn\r', false],
  ])('%j', (name, want) => {
    expect(isAttrDescription(name)).toBe(want)
  })
})

describe('fold', () => {
  it('wraps at 76 with one-space continuations', () => {
    const line = 'description: ' + 'x'.repeat(150)
    const out = fold(line)
    const parts = out.split('\n')
    expect(parts[0]).toHaveLength(76)
    expect(parts.slice(1).every((p) => p.startsWith(' ') && p.length <= 76)).toBe(true)
    expect(
      parts[0] +
        parts
          .slice(1)
          .map((p) => p.slice(1))
          .join(''),
    ).toBe(line)
    expect(fold('short')).toBe('short')
  })
})

describe('entryToLDIF', () => {
  it('writes text, base64 and masked attributes', () => {
    const ldif = entryToLDIF({
      dn: 'cn=Jürgen,dc=org',
      attributes: [
        { name: 'cn', values: [{ text: 'Jürgen' }] },
        { name: 'mail', values: [{ text: 'j@example.org' }] },
        { name: 'objectSid', values: [{ text: 'AQUAAAAAAAU=', base64: true, display: 'S-1-5' }] },
        { name: 'userPassword', values: [], masked: 2 },
      ],
    })
    expect(ldif).toBe(
      [
        'dn:: Y249SsO8cmdlbixkYz1vcmc=',
        'cn:: SsO8cmdlbg==',
        'mail: j@example.org',
        'objectSid:: AQUAAAAAAAU=',
        '# userPassword: 2 value(s) hidden',
        '',
      ].join('\n'),
    )
  })

  it('skips an attribute name that would inject records', () => {
    const name = 'description: exported\n\ndn: cn=admin,dc=example,dc=com\nchangetype: delete\n'
    const out = entriesToLDIF([
      {
        dn: 'uid=mallory,dc=example,dc=com',
        attributes: [
          { name: 'cn', values: [{ text: 'Mallory' }] },
          { name, values: [{ text: 'x' }, { text: 'y' }] },
          { name, values: [], masked: 1 },
        ],
      },
    ])
    const lines = out.split('\n')
    const dn = lines.findIndex((l) => l.startsWith('dn'))
    expect(lines.filter((l) => l.startsWith('dn'))).toHaveLength(1)
    expect(lines.filter((l) => l.startsWith('changetype'))).toEqual([])
    expect(lines.slice(dn, -1)).not.toContain('')
    // One comment per attribute, not per value.
    expect(lines.filter((l) => l === '# invalid attribute name skipped')).toHaveLength(2)
    expect(lines).toContain('cn: Mallory')
  })

  it('separates entries and adds the version line', () => {
    const out = entriesToLDIF([{ dn: 'dc=a' }, { dn: 'dc=b' }])
    expect(out).toBe('version: 1\n\ndn: dc=a\n\ndn: dc=b\n')
  })
})

describe('ldifPreview', () => {
  const jpeg = '/9j/' + 'A'.repeat(200)
  it('keeps text lines and folds a binary value into one summary', () => {
    const text = ['dn: uid=a,dc=x', fold(`jpegPhoto:: ${jpeg}`), 'cn: a', ''].join('\n')
    expect(ldifPreview(text)).toEqual([
      { text: 'dn: uid=a,dc=x' },
      { attr: 'jpegPhoto', base64: jpeg },
      { text: 'cn: a' },
    ])
  })
  it('decodes non-ASCII text values, folded or not, the dn too', () => {
    const ru = fold(`description:: ${base64UTF8('Привет, мир, это длинное описание пользователя')}`)
    const dn = `dn:: ${base64UTF8('cn=Jürgen Müller,dc=x')}`
    expect(ldifPreview(`${dn}\n${ru}\n`)).toEqual([
      { attr: 'dn', utf8: 'cn=Jürgen Müller,dc=x' },
      { attr: 'description', utf8: 'Привет, мир, это длинное описание пользователя' },
    ])
  })
  it('decodes a value with a no-break space inside it', () => {
    expect(ldifPreview(`cn:: ${base64UTF8('Иван\u00A0Петров')}`)).toEqual([
      { attr: 'cn', utf8: 'Иван\u00A0Петров' },
    ])
  })
  it.each([
    ['a line break', 'Строка\nвторая'],
    ['a control character', 'Знак\tтаб'],
    ['a leading space', ' Андрей'],
    ['a trailing space', 'Андрей '],
    ['a leading colon', ':Андрей'],
    ['a leading <', '<Андрей'],
    ['ASCII only', 'plain'],
    ['a C1 next-line character', 'Андрей\u0085x'],
    ['a line separator', 'Андрей\u2028x'],
    ['a right-to-left override', 'Андрей\u202Ex'],
    ['a zero-width space', 'admin\u200Bй'],
    ['a trailing no-break space', 'Андрей\u00A0'],
    ['a leading byte order mark', '\uFEFFАндрей'],
  ])('keeps base64 for text with %s', (_, value) => {
    const line = `description:: ${base64UTF8(value)}`
    expect(ldifPreview(line)).toEqual([{ text: line }])
  })
  it('keeps a blank line between blocks', () => {
    expect(ldifPreview('a: 1\n\nb: 2\n')).toEqual([
      { text: 'a: 1' },
      { text: '' },
      { text: 'b: 2' },
    ])
  })
})
