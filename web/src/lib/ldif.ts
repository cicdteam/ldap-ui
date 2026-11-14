import type { Entry } from './types'

// RFC 2849 SAFE-STRING: ASCII without NUL, LF, CR; must not start with
// space, ':' or '<'. Trailing spaces are base64-encoded too so they survive.
/* eslint-disable no-control-regex -- the RFC defines SAFE-CHAR by byte range, control characters included */
const SAFE_INIT = /^[\x01-\x09\x0B\x0C\x0E-\x1F\x21-\x39\x3B\x3D-\x7F]/
const SAFE = /^[\x01-\x09\x0B\x0C\x0E-\x7F]*$/
/* eslint-enable no-control-regex */

export function isSafe(s: string): boolean {
  return s === '' || (SAFE_INIT.test(s) && SAFE.test(s) && !s.endsWith(' '))
}

/** Bytes as standard base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

export function base64UTF8(s: string): string {
  return bytesToBase64(new TextEncoder().encode(s))
}

export function ldifLine(name: string, text: string, isBase64: boolean): string {
  if (isBase64) return `${name}:: ${text}`
  return isSafe(text) ? `${name}: ${text}` : `${name}:: ${base64UTF8(text)}`
}

/** Folds an ASCII line at width; continuation lines start with one space. */
export function fold(l: string, width = 76): string {
  if (l.length <= width) return l
  const parts = [l.slice(0, width)]
  for (let i = width; i < l.length; i += width - 1) parts.push(' ' + l.slice(i, i + width - 1))
  return parts.join('\n')
}

export function entryToLDIF(e: Entry): string {
  const lines = [fold(ldifLine('dn', e.dn, false))]
  for (const a of e.attributes ?? []) {
    if (a.masked) lines.push(`# ${a.name}: ${a.masked} value(s) hidden`)
    for (const v of a.values ?? []) lines.push(fold(ldifLine(a.name, v.text, v.base64 === true)))
  }
  return lines.join('\n') + '\n'
}

export function entriesToLDIF(entries: Entry[]): string {
  return 'version: 1\n\n' + entries.map(entryToLDIF).join('\n')
}

/** A line of LDIF as shown, or a binary value shown as a summary. */
export type PreviewPart = { text: string } | { attr: string; base64: string }

const utf8 = new TextDecoder('utf-8', { fatal: true })

function isText(b64: string): boolean {
  try {
    utf8.decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
    return true
  } catch {
    return false
  }
}

/**
 * Splits LDIF for display: a base64 value that is not UTF-8 text (a photo, a
 * certificate) becomes one part instead of a wall of folded lines. Copy and
 * download keep using the full LDIF.
 */
export function ldifPreview(ldif: string): PreviewPart[] {
  const lines = ldif.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const out: PreviewPart[] = []
  for (let i = 0; i < lines.length;) {
    let j = i + 1
    while (j < lines.length && lines[j].startsWith(' ')) j++
    const physical = lines.slice(i, j)
    const logical =
      physical[0] +
      physical
        .slice(1)
        .map((l) => l.slice(1))
        .join('')
    const m = /^([^:\s]+):: (.*)$/.exec(logical)
    if (m && !isText(m[2])) out.push({ attr: m[1], base64: m[2] })
    else out.push(...physical.map((text) => ({ text })))
    i = j
  }
  return out
}
