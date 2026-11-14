import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import { collect, isCursorExpired, nextSort, sortEntries } from './results'
import type { Entry } from './types'

const e = (dn: string, cn?: string): Entry => ({
  dn,
  attributes: cn === undefined ? [] : [{ name: 'cn', values: [{ text: cn }] }],
})

describe('collect', () => {
  it('flattens pages and merges flags', () => {
    expect(
      collect([
        { entries: [e('cn=a')], cursor: 'x' },
        { entries: [e('cn=b')], truncated: true, referrals: ['ldap://other/'] },
        {},
      ]),
    ).toEqual({ entries: [e('cn=a'), e('cn=b')], truncated: true, referrals: ['ldap://other/'] })
    expect(collect([])).toEqual({ entries: [], truncated: false, referrals: [] })
  })
})

describe('sorting', () => {
  const list = [
    e('cn=user10', 'user10'),
    e('cn=User2', 'User2'),
    e('cn=none'),
    e('cn=alpha', 'alpha'),
  ]

  it('cycles ascending, descending, off', () => {
    expect(nextSort(null, 'cn')).toEqual({ column: 'cn', desc: false })
    expect(nextSort({ column: 'cn', desc: false }, 'cn')).toEqual({ column: 'cn', desc: true })
    expect(nextSort({ column: 'cn', desc: true }, 'cn')).toBeNull()
    expect(nextSort({ column: 'cn', desc: true }, 'mail')).toEqual({ column: 'mail', desc: false })
  })

  it('sorts naturally and case-insensitively, empty values last', () => {
    expect(sortEntries(list, { column: 'cn', desc: false }).map((x) => x.dn)).toEqual([
      'cn=alpha',
      'cn=User2',
      'cn=user10',
      'cn=none',
    ])
    expect(sortEntries(list, { column: 'cn', desc: true }).map((x) => x.dn)).toEqual([
      'cn=user10',
      'cn=User2',
      'cn=alpha',
      'cn=none',
    ])
    expect(sortEntries(list, null)).toBe(list)
  })
})

describe('isCursorExpired', () => {
  it('recognizes the 410 code', () => {
    expect(isCursorExpired(new ApiError(410, { code: 'cursor_expired', message: '' }))).toBe(true)
    expect(isCursorExpired(new ApiError(400, { code: 'bad_request', message: '' }))).toBe(false)
    expect(isCursorExpired(new Error('x'))).toBe(false)
  })
})
