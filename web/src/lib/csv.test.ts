import { describe, expect, it } from 'vitest'
import { cellValue, csvField, toCSV } from './csv'
import type { Entry } from './types'

const e: Entry = {
  dn: 'cn=a,dc=org',
  attributes: [
    { name: 'CN', values: [{ text: 'a' }] },
    { name: 'mail', values: [{ text: 'a@x' }, { text: 'b@x' }] },
    { name: 'objectSid', values: [{ text: 'AQU=', base64: true, display: 'S-1-5' }] },
    { name: 'userPassword', masked: 1 },
  ],
}

describe('cellValue', () => {
  it('finds attributes case-insensitively and joins values', () => {
    expect(cellValue(e, 'dn')).toBe('cn=a,dc=org')
    expect(cellValue(e, 'cn')).toBe('a')
    expect(cellValue(e, 'mail')).toBe('a@x; b@x')
    expect(cellValue(e, 'objectsid')).toBe('S-1-5')
    expect(cellValue(e, 'userPassword')).toBe('(hidden)')
    expect(cellValue(e, 'missing')).toBe('')
  })
})

describe('csvField', () => {
  it.each([
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
    [' padded', '" padded"'],
    ['=cmd()', "'=cmd()"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@x', "'@x"],
    // Every value of the "; " join, and every tab-separated segment, starts defused.
    ['x;=1+1', "x;'=1+1"],
    ["x;=cmd|' /C calc'!A0", "x;'=cmd|' /C calc'!A0"],
    ['x;+1+1', "x;'+1+1"],
    ['x;@SUM(1+1)', "x;'@SUM(1+1)"],
    ['ok; =1+1', "ok; '=1+1"],
    // A leading tab or CR is a formula trigger of its own; a CR also makes the field quoted.
    ['\tcmd', "'\tcmd"],
    ['\rcmd', `"'\rcmd"`],
    ['a\t=1+1', "a\t'=1+1"],
    ['a-b', 'a-b'],
    ['Doe, John', '"Doe, John"'],
    ['a\n- b', '"a\n- b"'],
    ['1,-2', '"1,-2"'],
  ])('%j', (s, want) => {
    expect(csvField(s)).toBe(want)
  })
})

describe('toCSV', () => {
  it('puts dn first and uses CRLF', () => {
    expect(toCSV([e], ['cn', 'DN', 'mail'])).toBe('dn,cn,mail\r\n"cn=a,dc=org",a,a@x; b@x\r\n')
  })
  it('defuses a formula in any value of a multi-valued cell', () => {
    const f: Entry = {
      dn: 'cn=f,dc=org',
      attributes: [{ name: 'description', values: [{ text: 'ok' }, { text: '=1+1' }] }],
    }
    expect(toCSV([f], ['description'])).toBe(`dn,description\r\n"cn=f,dc=org",ok; '=1+1\r\n`)
  })
})
