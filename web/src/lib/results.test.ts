import { describe, expect, it } from 'vitest'
import { RESULT_LIMITS, nextLimit, nextSort, sortEntries } from './results'
import type { Entry } from './types'

const e = (dn: string, cn?: string): Entry => ({
  dn,
  attributes: cn === undefined ? [] : [{ name: 'cn', values: [{ text: cn }] }],
})

describe('nextLimit', () => {
  it('steps through the limits and stops at the last', () => {
    expect(RESULT_LIMITS).toEqual([500, 1000, 2000, 5000])
    expect(nextLimit(500)).toBe(1000)
    expect(nextLimit(1000)).toBe(2000)
    expect(nextLimit(2000)).toBe(5000)
    expect(nextLimit(5000)).toBeNull()
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
