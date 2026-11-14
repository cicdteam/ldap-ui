import { describe, expect, it } from 'vitest'
import { isEditableTarget, isKey, isMacPlatform, isModKey, keyLabel } from './shortcuts'

describe('platform', () => {
  it('detects Apple platforms', () => {
    expect(isMacPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)')).toBe(true)
    expect(isMacPlatform('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe(true)
    expect(isMacPlatform('Mozilla/5.0 (Windows NT 10.0; Win64)')).toBe(false)
    expect(isMacPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe(false)
  })
})

describe('keyLabel', () => {
  it.each([
    ['Mod+K', true, '⌘K'],
    ['Mod+K', false, 'Ctrl+K'],
    ['Mod+Enter', true, '⌘↵'],
    ['Mod+Enter', false, 'Ctrl+Enter'],
    ['Shift+Alt+F', true, '⇧⌥F'],
    ['Shift+Alt+F', false, 'Shift+Alt+F'],
    ['Mod+Backspace', true, '⌘⌫'],
    ['Mod+Backspace', false, 'Ctrl+Backspace'],
    ['/', true, '/'],
  ])('%s mac=%s', (combo, mac, want) => {
    expect(keyLabel(combo, mac)).toBe(want)
  })
})

describe('isModKey', () => {
  const ev = (key: string, metaKey: boolean, ctrlKey: boolean) => ({
    key,
    metaKey,
    ctrlKey,
    altKey: false,
    shiftKey: false,
  })
  it('uses Cmd on Mac and Ctrl elsewhere', () => {
    expect(isModKey(ev('k', true, false), 'k', true)).toBe(true)
    expect(isModKey(ev('K', true, false), 'k', true)).toBe(true)
    expect(isModKey(ev('k', false, true), 'k', true)).toBe(false)
    expect(isModKey(ev('k', false, true), 'k', false)).toBe(true)
    expect(isModKey(ev('j', false, true), 'k', false)).toBe(false)
  })
  it('matches the physical key on non-Latin layouts', () => {
    const ru = (key: string, code: string, metaKey: boolean, ctrlKey: boolean) => ({
      ...ev(key, metaKey, ctrlKey),
      code,
    })
    expect(isModKey(ru('л', 'KeyK', true, false), 'k', true)).toBe(true)
    expect(isModKey(ru('л', 'KeyK', false, true), 'k', false)).toBe(true)
    expect(isModKey(ru('д', 'KeyL', true, false), 'k', true)).toBe(false)
    expect(isModKey(ru('л', 'KeyK', false, true), 'k', true)).toBe(false)
  })
})

describe('isKey', () => {
  const ev = (
    key: string,
    mods: Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>> = {},
  ) => ({
    key,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
  })
  it('matches a key alone, in any case, with no modifier', () => {
    expect(isKey(ev('n'), 'N', true)).toBe(true)
    expect(isKey(ev('F2'), 'F2', true)).toBe(true)
    expect(isKey(ev('Delete'), 'Delete', false)).toBe(true)
    expect(isKey(ev('Backspace'), 'Delete', false)).toBe(false)
    for (const m of ['meta', 'ctrl', 'alt', 'shift'] as const) {
      expect(isKey(ev('Delete', { [m]: true }), 'Delete', true)).toBe(false)
    }
  })
  it('matches Mod plus a key: Cmd on Mac, Ctrl elsewhere, nothing else', () => {
    expect(isKey(ev('Backspace', { meta: true }), 'Mod+Backspace', true)).toBe(true)
    expect(isKey(ev('Backspace', { ctrl: true }), 'Mod+Backspace', false)).toBe(true)
    expect(isKey(ev('Backspace', { ctrl: true }), 'Mod+Backspace', true)).toBe(false)
    expect(isKey(ev('Backspace'), 'Mod+Backspace', true)).toBe(false)
    expect(isKey(ev('Backspace', { meta: true, shift: true }), 'Mod+Backspace', true)).toBe(false)
    expect(isKey(ev('Backspace', { meta: true, alt: true }), 'Mod+Backspace', true)).toBe(false)
  })
})

describe('isEditableTarget', () => {
  it('spots inputs and contenteditable', () => {
    expect(isEditableTarget({ tagName: 'INPUT', isContentEditable: false })).toBe(true)
    expect(isEditableTarget({ tagName: 'TEXTAREA', isContentEditable: false })).toBe(true)
    expect(isEditableTarget({ tagName: 'SELECT', isContentEditable: false })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
