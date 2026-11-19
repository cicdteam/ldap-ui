import { errorKind, errorMessage, isApiError } from './api'
import { base64ToBytes } from './binary'
import { isUnder, joinDN, normDN, sameDN, splitDN } from './dn'
import { isSecret } from './edit'
import { base64UTF8, bytesToBase64, entriesToLDIF, isAttrDescription } from './ldif'
import { baseName, type SchemaIndex } from './schema'
import type { AddRequest, Attribute, Entry, Info, Value } from './types'

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

/** Longest common suffix of the DNs, by RDN, in the first DN's spelling; '' when none. */
export function commonBase(dns: string[]): string {
  const rdns = splitDN(dns[0] ?? '')
  for (let i = 0; i < rdns.length; i++) {
    const base = joinDN(rdns.slice(i))
    if (dns.every((dn) => isUnder(dn, base))) return base
  }
  return ''
}

/** "Becomes" default: here if given; else from itself when it lies under a naming context (or baseDN); else the first naming context, else baseDN. */
export function defaultTarget(
  from: string,
  info: Pick<Info, 'namingContexts' | 'baseDN'>,
  here?: string,
): string {
  if (here) return here
  const bases = [...(info.namingContexts ?? []), info.baseDN].filter(Boolean)
  if (bases.some((b) => isUnder(from, b))) return from
  return bases[0] ?? ''
}

/** dn with its from suffix replaced by to; dn unchanged when not under from or from equals to. */
export function rebase(dn: string, from: string, to: string): string {
  if (!isUnder(dn, from) || sameDN(from, to)) return dn
  const rdns = splitDN(dn)
  return joinDN([...rdns.slice(0, rdns.length - splitDN(from).length), ...splitDN(to)])
}

export interface PlanItem {
  /** After the swap. */
  dn: string
  line: number
  /** After the swap and the filters; its dn equals PlanItem.dn. */
  entry: Entry
  unsupported?: string
  warnings: string[]
}

export interface ImportPlan {
  /** Creation order: DN depth, stable; unsupported items included. */
  items: PlanItem[]
  /** Server-managed attribute names, first spelling, sorted. */
  leftOut: string[]
  /** Secret values dropped. */
  passwords: number
}

/**
 * Swaps from for to in every DN and in DN-valued text values under from, leaves out secret and
 * server-managed attributes, merges attribute spellings that differ only in case (a server refuses
 * an add that gives a type twice) and orders parents first. Warnings need a schema and read nothing
 * from the server.
 */
export function planImport(
  records: LdifRecord[],
  from: string,
  to: string,
  schema: SchemaIndex,
): ImportPlan {
  const inFile = new Set(records.map((r) => normDN(r.entry.dn)))
  const leftOut = new Map<string, string>()
  let passwords = 0
  const items = records.map(({ line, entry, unsupported }): PlanItem => {
    const dn = rebase(entry.dn, from, to)
    const warnings: string[] = []
    const merged = new Map<string, Attribute>()
    const seen = new Set<string>()
    for (const a of entry.attributes ?? []) {
      const key = a.name.toLowerCase()
      if (isSecret(a.name, schema)) {
        passwords += a.values?.length ?? 0
        continue
      }
      if (schema.attr(a.name)?.noUserModification || schema.isOperational(a.name)) {
        if (!leftOut.has(key)) leftOut.set(key, a.name)
        continue
      }
      let m = merged.get(key)
      if (!m) {
        merged.set(key, (m = { name: a.name, values: [] }))
        if (!schema.attr(a.name)) warnings.push(`attribute ${a.name} not in schema`)
      }
      const isDN = schema.isDN(a.name)
      for (const v of a.values ?? []) {
        // Base64 values are binary, never a DN to swap.
        const swap = isDN && !v.base64 && isUnder(v.text, from)
        const out = swap ? { text: rebase(v.text, from, to) } : v
        const id = `${key}\n${out.base64 ? 'b' : 't'}${out.text}`
        if (seen.has(id)) continue
        seen.add(id)
        m.values?.push(out)
        if (swap && !inFile.has(normDN(v.text)))
          warnings.push(`${a.name} outside the import: ${out.text}`)
      }
    }
    const attributes = [...merged.values()]
    const classes =
      attributes.find((a) => baseName(a.name) === 'objectclass')?.values?.map((v) => v.text) ?? []
    const have = new Set(attributes.map((a) => schema.key(a.name)))
    for (const k of schema.allowed(classes).must)
      if (!have.has(k))
        warnings.push(`missing ${schema.attr(k)?.names?.[0] ?? k}, required by its object classes`)
    return {
      dn,
      line,
      entry: { dn, attributes },
      unsupported,
      warnings: schema.available ? warnings : [],
    }
  })
  items.sort((a, b) => splitDN(a.dn).length - splitDN(b.dn).length)
  return {
    items,
    leftOut: [...leftOut.values()].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    ),
    passwords,
  }
}

export type Outcome =
  | { kind: 'created' }
  | { kind: 'exists' }
  | { kind: 'failed'; message: string }
  | { kind: 'not-imported'; reason: 'parent' | 'stopped' }
  | { kind: 'unsupported'; reason: string }

/** The outcome of a record before it is sent: unsupported, or not imported because an earlier failed or unsupported DN is above it; undefined means send it. */
export function precheck(item: PlanItem, done: ReadonlyMap<string, Outcome>): Outcome | undefined {
  if (item.unsupported) return { kind: 'unsupported', reason: item.unsupported }
  // ponytail: scans every outcome per item, O(n^2) at 5000 records next to 5000 adds; look up
  // the item's ancestors in a set of normDN keys if it ever shows.
  for (const [dn, o] of done)
    if (
      (o.kind === 'failed' || o.kind === 'unsupported') &&
      isUnder(item.dn, dn) &&
      !sameDN(item.dn, dn)
    )
      return { kind: 'not-imported', reason: 'parent' }
  return undefined
}

/** The outcome of a failed add: exists for result 68, else failed with errorMessage(e). */
export function addFailure(e: unknown): Outcome {
  if (isApiError(e) && e.body.ldapResultCode === 68) return { kind: 'exists' }
  return { kind: 'failed', message: errorMessage(e) }
}

/**
 * Whether e ends the whole run: a lost token or session, a lost LDAP connection (502 network), or
 * ldaplens out of reach (the request itself failed).
 */
export function endsRun(e: unknown): boolean {
  if (!isApiError(e)) return true
  const kind = errorKind(e)
  return kind === 'auth' || kind === 'session' || e.code === 'network' || e.code === 'offline'
}

/** The add request for item: an attribute with a binary value goes all in base64, as the server takes one encoding per attribute. */
export function addRequest(item: PlanItem): AddRequest {
  return {
    dn: item.dn,
    attributes: (item.entry.attributes ?? []).map(({ name, values = [] }) =>
      values.some((v) => v.base64)
        ? {
            name,
            values: values.map((v) => (v.base64 ? v.text : base64UTF8(v.text))),
            base64: true,
          }
        : { name, values: values.map((v) => v.text) },
    ),
  }
}

/** The failed and not-imported records in plan order, as entriesToLDIF writes them. */
export function failedLDIF(plan: ImportPlan, outcomes: ReadonlyMap<string, Outcome>): string {
  const entries = plan.items
    .filter((i) => {
      const kind = outcomes.get(i.dn)?.kind
      return kind === 'failed' || kind === 'not-imported'
    })
    .map((i) => i.entry)
  return entries.length ? entriesToLDIF(entries) : ''
}
