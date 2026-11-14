export function isMacPlatform(
  ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): boolean {
  return /Mac|iPhone|iPad/.test(ua)
}

const MAC: Record<string, string> = {
  Mod: '⌘',
  Shift: '⇧',
  Alt: '⌥',
  Enter: '↵',
  Backspace: '⌫',
}

/** "Mod+K" as the platform writes it: "⌘K" on Apple, "Ctrl+K" elsewhere. */
export function keyLabel(combo: string, mac: boolean = isMacPlatform()): string {
  const parts = combo === '+' ? ['+'] : combo.split('+')
  if (mac) return parts.map((p) => MAC[p] ?? p).join('')
  return parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)).join('+')
}

interface KeyLike {
  key: string
  /** The physical key ("KeyK"); matches when a non-Latin layout makes key "л". */
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** Mod (Cmd on Apple, Ctrl elsewhere) plus key, no other modifiers. */
export function isModKey(e: KeyLike, key: string, mac: boolean = isMacPlatform()): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  const physical = /^[a-z]$/i.test(key) && e.code === `Key${key.toUpperCase()}`
  return mod && !e.altKey && (e.key.toLowerCase() === key.toLowerCase() || physical)
}

/**
 * e is combo as keyLabel takes it, a key alone ("N", "F2", "Delete") or Mod plus a key
 * ("Mod+Backspace"), with no other modifier.
 */
export function isKey(e: KeyLike, combo: string, mac: boolean = isMacPlatform()): boolean {
  if (e.shiftKey) return false
  if (combo.startsWith('Mod+')) return isModKey(e, combo.slice(4), mac)
  return !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === combo.toLowerCase()
}

export function isEditableTarget(
  t: { tagName?: string; isContentEditable?: boolean } | null,
): boolean {
  if (!t) return false
  return t.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName ?? '')
}
