import type { Entry } from './types'

// RFC 2849 SAFE-STRING: ASCII without NUL, LF, CR; must not start with
// space, ':' or '<'. Trailing spaces are base64-encoded too so they survive.
/* eslint-disable no-control-regex -- the RFC defines SAFE-CHAR by byte range, control characters included */
const SAFE_INIT = /^[\x01-\x09\x0B\x0C\x0E-\x1F\x21-\x39\x3B\x3D-\x7F]/
const SAFE = /^[\x01-\x09\x0B\x0C\x0E-\x7F]*$/
const NON_ASCII = /[^\x00-\x7F]/
/* eslint-enable no-control-regex */
/**
 * Characters a reader cannot see or that reorder text: controls, format (bidi, zero-width, BOM),
 * line and paragraph separators, default-ignorables (variation selectors, fillers), private use
 * and unassigned code points. No g flag: test() keeps no state.
 */
export const HIDDEN =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Co}\P{Assigned}]/u

/** RFC 4512 attribute description: a name or numeric OID, then options (;lang-de, ;binary, AD's ;range=0-1499). */
const ATTR_DESCRIPTION = /^([A-Za-z][A-Za-z0-9-]*|[0-9]+(\.[0-9]+)+)(;[A-Za-z0-9=*-]+)*$/
/** Stands in for a line whose attribute name could break out of it and inject LDIF records. */
export const SKIPPED_NAME = '# invalid attribute name skipped'

export function isAttrDescription(name: string): boolean {
  return ATTR_DESCRIPTION.test(name)
}

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
  if (!isAttrDescription(name)) return SKIPPED_NAME
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
    if (!isAttrDescription(a.name)) {
      lines.push(SKIPPED_NAME)
      continue
    }
    if (a.masked) lines.push(`# ${a.name}: ${a.masked} value(s) hidden`)
    for (const v of a.values ?? []) lines.push(fold(ldifLine(a.name, v.text, v.base64 === true)))
  }
  return lines.join('\n') + '\n'
}

export function entriesToLDIF(entries: Entry[]): string {
  return 'version: 1\n\n' + entries.map(entryToLDIF).join('\n')
}

/** The Copy LDIF tooltip: the preview decodes text, the copy is strict LDIF. */
export const COPY_LDIF_HINT = 'Copy as LDIF (RFC 2849: non-ASCII values as base64)'

/**
 * A line of LDIF as shown, a binary value shown as a summary, or a non-ASCII
 * text value shown decoded (the LDIF itself keeps it as base64).
 */
export type PreviewPart =
  { text: string } | { attr: string; base64: string } | { attr: string; utf8: string }

// ignoreBOM keeps a leading U+FEFF in the text, so readable() can refuse it instead of hiding it.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** The UTF-8 text in b64, or undefined for bytes that are not UTF-8 (a photo, a certificate). */
function decodeText(b64: string): string | undefined {
  try {
    return utf8.decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
  } catch {
    return undefined
  }
}

/**
 * Text that reads the same decoded: non-ASCII, one line, nothing invisible or reordering, and
 * none of the edge cases (leading whitespace, ':' or '<', trailing whitespace) that base64 keeps visible.
 */
function readable(s: string): boolean {
  return NON_ASCII.test(s) && !HIDDEN.test(s) && !/^[\s:<]/.test(s) && !/\s$/.test(s)
}

/**
 * Splits LDIF for display: a base64 value that is not UTF-8 text (a photo, a
 * certificate) becomes one part instead of a wall of folded lines, and one that
 * is readable non-ASCII text (names in Cyrillic, umlauts) is shown decoded.
 * Copy and download keep using the full RFC 2849 LDIF.
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
    const text = m ? decodeText(m[2]) : undefined
    if (m && text === undefined) out.push({ attr: m[1], base64: m[2] })
    else if (m && text !== undefined && readable(text)) out.push({ attr: m[1], utf8: text })
    else out.push(...physical.map((text) => ({ text })))
    i = j
  }
  return out
}
