import { describe, expect, it } from 'vitest'
import { base64UTF8, entriesToLDIF, entryToLDIF, fold, isSafe, ldifPreview } from './ldif'

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
  it('shows base64 that is text, such as non-ASCII values, as it is', () => {
    const ru = fold(`description:: ${base64UTF8('Привет, мир')}`)
    expect(ldifPreview(ru)).toEqual(ru.split('\n').map((text) => ({ text })))
  })
  it('keeps a blank line between blocks', () => {
    expect(ldifPreview('a: 1\n\nb: 2\n')).toEqual([
      { text: 'a: 1' },
      { text: '' },
      { text: 'b: 2' },
    ])
  })
})
