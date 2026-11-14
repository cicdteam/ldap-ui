import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBatchStore } from './batchStore'
import { dropEntry } from './changes'

const DN = 'uid=a,dc=x'

// Node 26 has an in-memory sessionStorage that would leak batches between
// tests; without it the store must still work in memory.
beforeEach(() => vi.stubGlobal('sessionStorage', undefined))
afterEach(() => vi.unstubAllGlobals())

describe('batch store', () => {
  it('persists per profile in sessionStorage', () => {
    const m = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    })
    createBatchStore().stage('p', DN, { kind: 'add', attr: 'mail', value: 'z' })
    expect(JSON.parse(m.get('ldapui:batch:p') ?? '')).toHaveLength(1)
    expect(createBatchStore().get('p')).toHaveLength(1)
  })
  it('stages, notifies, keeps identity until a change', () => {
    const s = createBatchStore()
    const fn = vi.fn()
    s.subscribe(fn)
    const empty = s.get('p')
    expect(s.get('p')).toBe(empty)
    s.stage('p', DN, { kind: 'add', attr: 'mail', value: 'z' })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(s.get('p')).not.toBe(empty)
    expect(s.get('p')).toHaveLength(1)
    expect(s.get('other')).toEqual([])
  })
  it('undo and redo', () => {
    const s = createBatchStore()
    expect(s.undo('p')).toBe(false)
    s.stage('p', DN, { kind: 'add', attr: 'mail', value: 'z' })
    s.stage('p', DN, { kind: 'add', attr: 'mail', value: 'y' })
    expect(s.undo('p')).toBe(true)
    expect(s.get('p')[0].changes[0].values).toEqual(['z'])
    expect(s.redo('p')).toBe(true)
    expect(s.get('p')[0].changes[0].values).toEqual(['z', 'y'])
    expect(s.redo('p')).toBe(false)
    s.undo('p')
    s.stage('p', DN, { kind: 'add', attr: 'mail', value: 'w' })
    expect(s.redo('p')).toBe(false)
  })
  it('a no-op stage records nothing', () => {
    const s = createBatchStore()
    s.stage('p', DN, { kind: 'replace', attr: 'mail', from: 'a', to: 'a' })
    expect(s.undo('p')).toBe(false)
  })
  it('a duplicate add records nothing', () => {
    const s = createBatchStore()
    s.stage('p', DN, { kind: 'add', attr: 'mail', value: 'z' })
    s.stage('p', DN, { kind: 'add', attr: 'mail', value: 'z' })
    expect(s.undo('p')).toBe(true)
    expect(s.undo('p')).toBe(false)
  })
  it('an emptied batch is the shared empty one, so clear records nothing', () => {
    const s = createBatchStore()
    const empty = s.get('p')
    s.stage('p', DN, { kind: 'add', attr: 'mail', value: 'z' })
    s.stage('p', DN, { kind: 'delete', attr: 'mail', value: 'z' })
    expect(s.get('p')).toBe(empty)
    s.clear('p')
    let n = 0
    while (s.undo('p')) n++
    expect(n).toBe(2)
  })
  it('caps undo at 100', () => {
    const s = createBatchStore()
    for (let i = 0; i < 150; i++) s.stage('p', DN, { kind: 'add', attr: 'mail', value: String(i) })
    let n = 0
    while (s.undo('p')) n++
    expect(n).toBe(100)
  })
  it('errors are per entry and drop with the entry', () => {
    const s = createBatchStore()
    s.stage('p', DN, { kind: 'add', attr: 'mail', value: 'z' })
    s.setError('p', DN, { code: 'conflict', message: 'm' })
    expect(s.errorOf('p', 'UID=a,dc=x')?.code).toBe('conflict')
    s.clear('p')
    expect(s.get('p')).toEqual([])
    expect(s.errorOf('p', DN)).toBeUndefined()
    expect(s.undo('p')).toBe(true)
    expect(s.get('p')).toHaveLength(1)
  })
  it('drops only the errors of entries that left the batch', () => {
    const s = createBatchStore()
    const B = 'uid=b,dc=x'
    s.stage('p', 'uid=A,dc=x', { kind: 'add', attr: 'mail', value: 'z' })
    s.stage('p', B, { kind: 'add', attr: 'mail', value: 'z' })
    s.setError('p', 'UID=a,dc=x', { code: 'conflict', message: 'a' })
    s.setError('p', B, { code: 'conflict', message: 'b' })
    s.set('p', dropEntry(s.get('p'), B))
    expect(s.errorOf('p', DN)?.message).toBe('a')
    expect(s.errorOf('p', B)).toBeUndefined()
  })
  it('reset sets the batch and forgets undo and redo', () => {
    const s = createBatchStore()
    s.stage('p', DN, { kind: 'add', attr: 'mail', value: 'z' })
    s.stage('p', DN, { kind: 'add', attr: 'mail', value: 'y' })
    s.undo('p')
    const kept = s.get('p')
    s.reset('p', kept)
    expect(s.get('p')).toBe(kept)
    expect(s.undo('p')).toBe(false)
    expect(s.redo('p')).toBe(false)
    s.reset('p', [])
    expect(s.get('p')).toEqual([])
    expect(s.undo('p')).toBe(false)
  })
  it('clear of an empty batch still notifies when it drops errors', () => {
    const s = createBatchStore()
    s.setError('p', DN, { code: 'conflict', message: 'm' })
    const fn = vi.fn()
    s.subscribe(fn)
    s.clear('p')
    expect(s.errorOf('p', DN)).toBeUndefined()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(s.undo('p')).toBe(false)
  })
  it('undoes a staged base64 value', () => {
    const s = createBatchStore()
    s.stage('p', DN, { kind: 'add', attr: 'jpegPhoto', value: '/9j/', base64: true })
    expect(s.get('p')[0].changes).toEqual([
      { op: 'add', attr: 'jpegPhoto', values: ['/9j/'], base64: true },
    ])
    expect(s.undo('p')).toBe(true)
    expect(s.get('p')).toEqual([])
  })
  it('keeps a batch over the sessionStorage quota in memory, and no older copy', () => {
    const m = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (v.length > 300) throw new DOMException('quota exceeded', 'QuotaExceededError')
        m.set(k, v)
      },
    })
    const s = createBatchStore()
    s.stage('p', DN, { kind: 'add', attr: 'mail', value: 'z' })
    expect(s.persisted('p')).toBe(true)
    const big = 'A'.repeat(400)
    s.stage('p', DN, { kind: 'add', attr: 'jpegPhoto', value: big, base64: true })
    expect(s.persisted('p')).toBe(false)
    expect(s.get('p')[0].changes).toEqual([
      { op: 'add', attr: 'mail', values: ['z'] },
      { op: 'add', attr: 'jpegPhoto', values: [big], base64: true },
    ])
    // A reload would find no batch rather than the older one.
    expect(m.get('ldapui:batch:p')).toBe('[]')
    expect(s.undo('p')).toBe(true)
    expect(s.persisted('p')).toBe(true)
    expect(JSON.parse(m.get('ldapui:batch:p') ?? '')).toHaveLength(1)
  })
})
