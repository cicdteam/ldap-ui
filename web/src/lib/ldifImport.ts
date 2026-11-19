import { base64ToBytes } from './binary'
import { bytesToBase64, isAttrDescription } from './ldif'
import type { Attribute, Entry, Value } from './types'

/** The most records one import takes. */
export const MAX_IMPORT_RECORDS = 5000

export interface LdifRecord {
  /** 1-based line of the record's dn: line. */
  line: number
  /** Attributes in file order, one Attribute per name spelling, values in file order; no dn, no changetype. */
  entry: Entry
  /** Why the record cannot be imported (changetype: modify, a < URL value); absent when it can. */
  unsupported?: string
}

/** A file that is not LDIF; the message starts with the line. */
export class LdifSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`Line ${line}: ${message}`)
  }
}

// ignoreBOM keeps a leading U+FEFF in a value instead of dropping it.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** The value after "name:": text, base64 that is not UTF-8 kept as base64, or undefined for a < URL. */
function value(rest: string, line: number): Value | undefined {
  if (rest.startsWith('<')) return undefined
  if (!rest.startsWith(':')) return { text: rest.replace(/^ +/, '') }
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(rest.slice(1))
  } catch {
    throw new LdifSyntaxError('invalid base64', line)
  }
  try {
    return { text: utf8.decode(bytes) }
  } catch {
    return { text: bytesToBase64(bytes), base64: true }
  }
}

/**
 * Reads RFC 2849 content records: version, comments, folded lines, base64 values
 * (text when they are UTF-8) and attribute options. A changetype other than add or
 * a < URL value makes the record unsupported; anything malformed throws.
 */
export function parseLDIF(text: string): LdifRecord[] {
  // Logical lines, each with the number of its first physical line.
  const lines: { text: string; line: number }[] = []
  text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .forEach((l, i) => {
      const last = lines.at(-1)
      if (l.startsWith(' ') && last) last.text += l.slice(1)
      else lines.push({ text: l, line: i + 1 })
    })

  const records: LdifRecord[] = []
  let rec: LdifRecord | undefined
  let attributes: Attribute[] = []
  let values = new Map<string, Value[]>()
  let skip = false // the rest of a changetype record, which holds no attribute lines
  for (const { text: l, line } of lines) {
    if (l === '') {
      rec = undefined
      skip = false
      continue
    }
    if (skip || l.startsWith('#')) continue
    const colon = l.indexOf(':')
    if (colon < 0) throw new LdifSyntaxError('not a "name: value" line', line)
    const name = l.slice(0, colon)
    const rest = l.slice(colon + 1)
    const key = name.toLowerCase()
    if (!rec) {
      if (key === 'version' && records.length === 0) continue
      if (key !== 'dn') throw new LdifSyntaxError('a record must start with dn:', line)
      const dn = value(rest, line)
      if (!dn || dn.base64) throw new LdifSyntaxError('the DN must be UTF-8 text', line)
      attributes = []
      values = new Map()
      rec = { line, entry: { dn: dn.text, attributes } }
      records.push(rec)
    } else if (key === 'dn') {
      throw new LdifSyntaxError('dn: inside a record, is a blank line missing?', line)
    } else if (key === 'changetype') {
      const type = rest.trim()
      if (type.toLowerCase() !== 'add') {
        rec.unsupported ??= `changetype: ${type}`
        skip = true
      }
    } else {
      if (!isAttrDescription(name))
        throw new LdifSyntaxError(`invalid attribute name "${name}"`, line)
      const v = value(rest, line)
      if (!v) {
        rec.unsupported ??= `URL value ${name}:< ${rest.slice(1).trim()}`
        continue
      }
      let vs = values.get(name)
      if (!vs) {
        vs = []
        values.set(name, vs)
        attributes.push({ name, values: vs })
      }
      vs.push(v)
    }
  }
  return records
}
