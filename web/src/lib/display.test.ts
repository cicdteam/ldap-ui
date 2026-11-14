import { describe, expect, it } from 'vitest'
import { byteLength, envBadges, formatDisplay, imageType, safeColor, shownValues } from './display'

describe('safeColor', () => {
  it.each([
    ['#fff', '#fff'],
    ['#12ab34', '#12ab34'],
    ['#12ab34cc', '#12ab34cc'],
    ['red', 'red'],
    ['', undefined],
    [undefined, undefined],
    ['url(http://evil)', undefined],
    ['red;background:url(x)', undefined],
    ['#12345', undefined],
    ['var(--x)', undefined],
  ])('%j', (c, want) => {
    expect(safeColor(c)).toBe(want)
  })
})

describe('envBadges', () => {
  it('labels with text, not only color', () => {
    expect(envBadges({ environment: 'prod', readOnly: true, insecureSkipVerify: true })).toEqual([
      { label: 'PROD', tone: 'danger' },
      { label: 'READ-ONLY', tone: 'neutral' },
      { label: 'INSECURE TLS', tone: 'danger' },
    ])
    expect(envBadges({ environment: 'dev', readOnly: false, insecureSkipVerify: false })).toEqual([
      { label: 'DEV', tone: 'neutral' },
    ])
    expect(
      envBadges({ environment: 'stage', readOnly: false, insecureSkipVerify: false })[0].tone,
    ).toBe('warn')
  })
})

describe('binary helpers', () => {
  it('sniffs images from base64', () => {
    expect(imageType('/9j/4AAQ')).toBe('image/jpeg')
    expect(imageType('iVBORw0KGgoAAA')).toBe('image/png')
    expect(imageType('R0lGODlh')).toBe('image/gif')
    expect(imageType('AQUAAAAAAAU=')).toBeUndefined()
  })

  it('counts decoded bytes', () => {
    expect(byteLength('')).toBe(0)
    expect(byteLength('AQU=')).toBe(2)
    expect(byteLength('AQ==')).toBe(1)
    expect(byteLength('AQUA')).toBe(3)
  })

  it('passes non-date displays through', () => {
    expect(formatDisplay({ text: '0', display: 'never' })).toBe('never')
    expect(formatDisplay({ text: 'plain' })).toBe('plain')
    expect(formatDisplay({ text: 'x', display: '2026-01-02T03:04:05Z' })).not.toBe(
      '2026-01-02T03:04:05Z',
    )
  })
})

describe('shownValues', () => {
  const values = Array.from({ length: 5000 }, (_, i) => ({ text: `cn=user${i},dc=x` }))
  const member = { name: 'member', values }

  it('caps a long list and grows with the limit', () => {
    const first = shownValues(member, '', 100)
    expect(first.shown).toHaveLength(100)
    expect(first.total).toBe(5000)
    expect(shownValues(member, '', 1100).shown).toHaveLength(1100)
  })

  it('keeps every value when the needle is in the name', () => {
    expect(shownValues(member, 'memb', 100).total).toBe(5000)
  })

  it('keeps only matching values, capped, with their original index', () => {
    // user4, user40..49, user400..499, user4000..4999
    const r = shownValues(member, 'user4', 100)
    expect(r.total).toBe(1111)
    expect(r.shown).toHaveLength(100)
    expect(r.shown[0]).toEqual({ value: values[4], index: 4 })
    expect(r.shown.every((s) => s.value.text.includes('user4'))).toBe(true)
  })

  it('matches the display form and handles masked-only attributes', () => {
    const sid = { name: 'objectSid', values: [{ text: 'AQUA', base64: true, display: 'S-1-5-21' }] }
    expect(shownValues(sid, 's-1-5', 100).total).toBe(1)
    expect(shownValues(sid, 'aqua', 100).total).toBe(0)
    expect(shownValues({ name: 'userPassword', masked: 1 }, 'x', 100)).toEqual({
      shown: [],
      total: 0,
    })
  })
})
