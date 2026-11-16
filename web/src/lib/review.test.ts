import { describe, expect, it } from 'vitest'
import type { Batch } from './changes'
import {
  afterApply,
  bannerShown,
  canApply,
  errorText,
  fieldMessage,
  flagged,
  invalidCount,
} from './review'
import { SchemaIndex } from './schema'
import type { Entry } from './types'

const A = 'uid=a,dc=x'
const B = 'uid=b,dc=x'
const C = 'uid=c,dc=x'
const batch: Batch = [A, B, C].map((dn) => ({
  dn,
  changes: [{ op: 'add', attr: 'mail', values: [`${dn}@x`] }],
}))

describe('afterApply', () => {
  it('drops applied entries whatever the DN spelling, keeps order and the failed one', () => {
    const res = {
      applied: ['UID=A,DC=X'],
      failed: { dn: B, error: { code: 'conflict', message: 'm' } },
    }
    expect(afterApply(batch, batch, res).map((e) => e.dn)).toEqual([B, C])
  })
  it('keeps the batch identity when nothing applied, so no undo step is recorded', () => {
    const res = { applied: [], failed: { dn: A, error: { code: 'conflict', message: 'm' } } }
    expect(afterApply(batch, batch, res)).toBe(batch)
  })
  it('empties the batch when all applied', () => {
    expect(afterApply(batch, batch, { applied: [A, B, C] })).toEqual([])
  })
  it('keeps an applied entry changed after it was sent, so later edits survive', () => {
    const later: Batch = [
      { dn: A, changes: [...batch[0].changes, { op: 'add', attr: 'cn', values: ['later'] }] },
      ...batch.slice(1),
    ]
    expect(afterApply(later, batch, { applied: [A, B] })).toEqual([later[0], later[2]])
  })
})

describe('canApply', () => {
  const ok = { batch, invalid: 0 }
  it('allows a valid batch', () => {
    expect(canApply(ok)).toBe(true)
  })
  it('refuses an empty batch', () => {
    expect(canApply({ ...ok, batch: [] })).toBe(false)
  })
  it('refuses invalid entries', () => {
    expect(canApply({ ...ok, invalid: 1 })).toBe(false)
  })
})

describe('invalidCount', () => {
  const idx = new SchemaIndex({
    attributeTypes: [
      { oid: '2.5.4.3', names: ['cn'] },
      { oid: '0.9.2342.19200300.100.1.3', names: ['mail'] },
    ],
    objectClasses: [{ oid: '1.1', names: ['person'], kind: 'STRUCTURAL', must: ['cn'] }],
  })
  const entry = (dn: string): Entry => ({
    dn,
    attributes: [
      { name: 'objectClass', values: [{ text: 'person' }] },
      { name: 'cn', values: [{ text: 'x' }] },
    ],
  })
  const dropCN: Batch = [A, B].map((dn) => ({
    dn,
    changes: [{ op: 'delete', attr: 'cn', values: ['x'] }],
  }))
  it('counts entries that fail validation against their loaded entry', () => {
    expect(invalidCount([...dropCN, batch[2]], [entry(A), entry(B), entry(C)], idx)).toBe(2)
  })
  it('skips entries that are not loaded', () => {
    expect(invalidCount(dropCN, [entry('UID=B,DC=X')], idx)).toBe(1)
  })
  it('is zero for valid changes', () => {
    expect(invalidCount(batch, [entry(A), entry(B), entry(C)], idx)).toBe(0)
  })
})

describe('errorText', () => {
  it('explains a conflict and passes other messages through', () => {
    expect(errorText({ code: 'conflict', message: 'no such attribute' })).toBe(
      'The entry changed since you read it.',
    )
    expect(errorText({ code: 'rejected', message: 'invalid per syntax' })).toBe(
      'invalid per syntax',
    )
  })
})

describe('fieldMessage', () => {
  const error = { code: 'rejected', message: 'invalid per syntax', attribute: 'MAIL' }
  it('shows the server error on the row it names, whatever the case', () => {
    expect(fieldMessage('mail', new Map(), error)).toBe('invalid per syntax')
    expect(fieldMessage('Mail', new Map(), error)).toBe('invalid per syntax')
  })
  it('tells an attribute with options from the attribute', () => {
    expect(fieldMessage('mail;binary', new Map(), error)).toBeUndefined()
    const de = { ...error, attribute: 'cn;LANG-DE' }
    expect(fieldMessage('cn;lang-de', new Map(), de)).toBe('invalid per syntax')
    expect(fieldMessage('cn', new Map(), de)).toBeUndefined()
  })
  it('lets a validation problem win over the server error', () => {
    expect(fieldMessage('mail', new Map([['mail', 'Empty values are not allowed']]), error)).toBe(
      'Empty values are not allowed',
    )
  })
  it('shows nothing on other rows or without an attribute', () => {
    expect(fieldMessage('cn', new Map(), error)).toBeUndefined()
    expect(fieldMessage('mail', new Map(), { ...error, attribute: undefined })).toBeUndefined()
    expect(fieldMessage('mail', new Map(), undefined)).toBeUndefined()
  })
})

describe('bannerShown', () => {
  const rejected = { code: 'rejected', message: 'invalid per syntax', attribute: 'MAIL' }
  const none = new Map<string, string>()
  it('hides the banner when a shown row carries the error', () => {
    expect(bannerShown(rejected, ['cn', 'Mail'], none)).toBe(false)
  })
  it('shows it when only a variant with options of the named attribute is shown', () => {
    expect(bannerShown(rejected, ['cn', 'mail;binary'], none)).toBe(true)
  })
  it('shows it when the named row is filtered out or collapsed', () => {
    expect(bannerShown(rejected, ['cn'], none)).toBe(true)
  })
  it('shows it when the named row shows a validation problem instead', () => {
    expect(
      bannerShown(rejected, ['mail'], new Map([['mail', 'Empty values are not allowed']])),
    ).toBe(true)
  })
  it('shows it for an error that names no attribute', () => {
    expect(bannerShown({ code: 'network', message: 'reset' }, ['mail'], none)).toBe(true)
  })
  it('always shows a conflict: its actions live there', () => {
    expect(bannerShown({ ...rejected, code: 'conflict' }, ['mail'], none)).toBe(true)
  })
})

describe('flagged', () => {
  const rows = (...names: string[]) => names.map((name) => ({ name }))
  const rejected = { code: 'rejected', message: 'invalid per syntax', attribute: 'MAIL' }
  const none = new Map<string, string>()
  it('is set by a validation problem on one of the rows', () => {
    expect(
      flagged(rows('cn', 'loginShell'), new Map([['loginshell', 'Not allowed']]), undefined),
    ).toBe(true)
  })
  it('is set by a server error naming one of the rows, whatever the case', () => {
    expect(flagged(rows('cn', 'mail'), none, rejected)).toBe(true)
  })
  it('is not set by an error or a problem elsewhere', () => {
    expect(flagged(rows('cn', 'mail;binary'), new Map([['sn', 'Empty']]), rejected)).toBe(false)
    expect(flagged(rows('cn'), none, { code: 'network', message: 'reset' })).toBe(false)
    expect(flagged(rows(), none, rejected)).toBe(false)
  })
})
