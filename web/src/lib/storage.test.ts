import { afterEach, describe, expect, it, vi } from 'vitest'
import { load, pushHistory, save, type SearchState } from './storage'

afterEach(() => {
  vi.unstubAllGlobals()
})

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  }
}

describe('load/save', () => {
  it('round-trips JSON', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    save('k', { a: 1 })
    expect(load('k', null)).toEqual({ a: 1 })
  })

  it('falls back when storage is missing, throws or holds junk', () => {
    // Stubbed missing: Node 26's own localStorage warns when read without --localstorage-file.
    vi.stubGlobal('localStorage', undefined)
    expect(load('k', 'fb')).toBe('fb')
    expect(() => save('k', 1)).not.toThrow()
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    expect(load('k', 'fb')).toBe('fb')
    expect(() => save('k', 1)).not.toThrow()
    const s = memoryStorage()
    s.setItem('k', '{not json')
    vi.stubGlobal('localStorage', s)
    expect(load('k', 'fb')).toBe('fb')
  })

  it('save reports whether it wrote', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      },
    })
    expect(save('k', 1)).toBe(false)
    vi.stubGlobal('localStorage', memoryStorage())
    expect(save('k', 1)).toBe(true)
  })
})

describe('pushHistory', () => {
  const q = (filter: string): SearchState => ({ base: '', scope: 'sub', filter, attrs: ['cn'] })

  it('puts the newest first and drops duplicates', () => {
    expect(pushHistory([q('a'), q('b')], q('b'))).toEqual([q('b'), q('a')])
  })

  it('caps the list', () => {
    const list = Array.from({ length: 5 }, (_, i) => q(String(i)))
    expect(pushHistory(list, q('x'), 3)).toEqual([q('x'), q('0'), q('1')])
  })

  it('compares regardless of key order', () => {
    const reordered = { attrs: ['cn'], filter: 'a', scope: 'sub', base: '' } as SearchState
    expect(pushHistory([q('a')], reordered)).toHaveLength(1)
  })
})
