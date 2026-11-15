import { looksLikeDN, sameDN, splitDN } from './dn'
import { fold, isAttrDescription, ldifLine, SKIPPED_NAME } from './ldif'
import { attrKey, SYNTAX, type SchemaIndex } from './schema'
import type { Entry, Value } from './types'

export interface Op {
  op: 'add' | 'delete'
  attr: string
  values: string[]
  /** Every value is standard base64 (binary); absent for text. */
  base64?: boolean
}
/**
 * One entry's staged changes: per attribute at most a text and a base64 delete, then a text and a
 * base64 add.
 */
export interface EntryChanges {
  dn: string
  changes: Op[]
}
export type Batch = EntryChanges[]
/** A staged edit; base64 marks a binary value, given as standard base64. */
export type Edit =
  | { kind: 'add'; attr: string; value: string; base64?: boolean }
  | { kind: 'delete'; attr: string; value: string; base64?: boolean }
  | { kind: 'replace'; attr: string; from: string; to: string }
export type Mark = 'added' | 'changed' | 'deleted' | 'stale'
export interface MarkedValue extends Value {
  mark?: Mark
}

const SYNTAX_INTEGER = '1.3.6.1.4.1.1466.115.121.1.27'
const GENERALIZED_TIME = /^\d{10}(\d{2}(\d{2})?)?([.,]\d+)?(Z|[+-]\d{4})$/

const sameAttr = (a: string, b: string) => attrKey(a) === attrKey(b)
const findAttr = (e: Entry, name: string) => e.attributes?.find((a) => sameAttr(a.name, name))
/** Texts of the text values: the syntax rules never apply to base64 ones. */
const texts = (vs: Value[] = []) => vs.filter((v) => !v.base64).map((v) => v.text)
/** A value as the batch holds it: its text, and base64 for a binary one. */
const val = (text: string, base64?: boolean): Value => (base64 ? { text, base64: true } : { text })
/** Values match by text and encoding: "AAEC" as text is not "AAEC" in base64. */
const same = (a: Value, b: Value) => a.text === b.text && !!a.base64 === !!b.base64
const has = (list: Value[], v: Value) => list.some((x) => same(x, v))

export function entryChanges(batch: Batch, dn: string): EntryChanges | undefined {
  return batch.find((e) => sameDN(e.dn, dn))
}

export function dropEntry(batch: Batch, dn: string): Batch {
  return batch.filter((e) => !sameDN(e.dn, dn))
}

export function touchedAttributes(batch: Batch): number {
  return batch.reduce((n, e) => n + new Set(e.changes.map((c) => attrKey(c.attr))).size, 0)
}

/** Per attribute: its first spelling, staged deletes and adds. */
interface Staged {
  attr: string
  del: Value[]
  add: Value[]
}

function unpack(ec: EntryChanges | undefined): Staged[] {
  const out: Staged[] = []
  for (const c of ec?.changes ?? []) {
    let s = out.find((x) => sameAttr(x.attr, c.attr))
    if (!s) out.push((s = { attr: c.attr, del: [], add: [] }))
    ;(c.op === 'delete' ? s.del : s.add).push(...c.values.map((t) => val(t, c.base64)))
  }
  return out
}

/** One attribute's operations of a kind: the text values, then the base64 ones, if any. */
function ops(op: Op['op'], attr: string, values: Value[]): Op[] {
  const text = values.filter((v) => !v.base64).map((v) => v.text)
  const b64 = values.filter((v) => v.base64).map((v) => v.text)
  const out: Op[] = []
  if (text.length) out.push({ op, attr, values: text })
  if (b64.length) out.push({ op, attr, values: b64, base64: true })
  return out
}

function pack(staged: Staged[]): Op[] {
  return staged.flatMap((s) => [...ops('delete', s.attr, s.del), ...ops('add', s.attr, s.add)])
}

function apply1(staged: Staged[], kind: 'add' | 'delete', attr: string, value: Value): Staged[] {
  if (value.text === '') return staged
  const out = staged.map((s) => ({ ...s, del: [...s.del], add: [...s.add] }))
  let s = out.find((x) => sameAttr(x.attr, attr))
  if (!s) out.push((s = { attr, del: [], add: [] }))
  const [mine, other] = kind === 'add' ? [s.add, s.del] : [s.del, s.add]
  const i = other.findIndex((x) => same(x, value))
  if (i >= 0) other.splice(i, 1)
  else if (!has(mine, value)) mine.push(value)
  return out.filter((x) => x.del.length || x.add.length)
}

export function stage(batch: Batch, dn: string, edit: Edit): Batch {
  const ec = entryChanges(batch, dn)
  let staged = unpack(ec)
  if (edit.kind === 'replace') {
    if (edit.from === edit.to) return batch
    staged = apply1(staged, 'delete', edit.attr, val(edit.from))
    staged = apply1(staged, 'add', edit.attr, val(edit.to))
  } else {
    staged = apply1(staged, edit.kind, edit.attr, val(edit.value, edit.base64))
  }
  const changes = pack(staged)
  if (!ec) return changes.length ? [...batch, { dn, changes }] : batch
  if (!changes.length) return dropEntry(batch, dn)
  // A no-op keeps the batch identity, so the store records no undo step.
  if (JSON.stringify(changes) === JSON.stringify(ec.changes)) return batch
  return batch.map((e) => (e === ec ? { dn: e.dn, changes } : e))
}

export function view(entry: Entry, ec: EntryChanges | undefined): Entry {
  const staged = unpack(ec)
  const attrs = [...(entry.attributes ?? [])]
  // A staged attribute the entry lacks is marked like one with no values.
  for (const s of staged)
    if (!attrs.some((a) => sameAttr(a.name, s.attr))) attrs.push({ name: s.attr, values: [] })
  return {
    ...entry,
    attributes: attrs.map((a) => {
      const s = staged.find((x) => sameAttr(x.attr, a.name))
      if (!s) return a
      const have = a.values ?? []
      const values: MarkedValue[] = have.map((v) => {
        if (has(s.del, v)) return { ...v, mark: 'deleted' }
        if (has(s.add, v)) return { ...v, mark: 'stale' }
        return v
      })
      for (const d of s.del) if (!has(have, d)) values.push({ ...d, mark: 'stale' })
      // A text add next to a text delete is a change; a new file is an addition.
      const changed = s.del.some((d) => !d.base64)
      for (const v of s.add)
        if (!has(have, v)) values.push({ ...v, mark: changed && !v.base64 ? 'changed' : 'added' })
      return { ...a, values }
    }),
  }
}

/**
 * The entry once ec applies: values staged for delete gone, staged adds in, no marks and no
 * display text; attributes left without values (and not masked) are dropped.
 */
export function applied(entry: Entry, ec: EntryChanges | undefined): Entry {
  const staged = unpack(ec)
  const attributes = (view(entry, ec).attributes ?? []).flatMap((a) => {
    const del = staged.find((s) => sameAttr(s.attr, a.name))?.del ?? []
    const values: Value[] = (a.values ?? [])
      .filter((v) => !has(del, v))
      .map((v) => val(v.text, v.base64))
    return values.length || a.masked ? [{ ...a, values }] : []
  })
  return { ...entry, attributes }
}

/**
 * MUST attributes (schema spelling) the staged classes add over the entry's original ones and the
 * staged view has no row for, while ec touches objectClass. MUSTs the original classes already had
 * are never reported: a read may omit ones the server manages (AD's nTSecurityDescriptor on top).
 */
export function missingMust(
  entry: Entry,
  ec: EntryChanges | undefined,
  schema: SchemaIndex,
): string[] {
  if (!schema.available || !unpack(ec).some((s) => sameAttr(s.attr, 'objectClass'))) return []
  const { must } = schema.allowed(texts(findAttr(applied(entry, ec), 'objectClass')?.values))
  const before = schema.allowed(texts(findAttr(entry, 'objectClass')?.values)).must
  const rows = new Set((view(entry, ec).attributes ?? []).map((a) => schema.key(a.name)))
  // ponytail: attributes the server sets (AD system MUSTs) are not asked for; it fills them.
  return [...must]
    .filter((k) => !before.has(k) && !rows.has(k))
    .filter((k) => !schema.isOperational(k) && !schema.attr(k)?.noUserModification)
    .map((k) => schema.attr(k)?.names?.[0] ?? k)
}

export function dropStale(batch: Batch, entry: Entry): Batch {
  const ec = entryChanges(batch, entry.dn)
  if (!ec) return batch
  let out = batch
  for (const s of unpack(ec)) {
    const have = findAttr(entry, s.attr)?.values ?? []
    for (const d of s.del)
      if (!has(have, d))
        out = stage(out, ec.dn, { kind: 'add', attr: s.attr, value: d.text, base64: d.base64 })
    for (const v of s.add)
      if (has(have, v))
        out = stage(out, ec.dn, { kind: 'delete', attr: s.attr, value: v.text, base64: v.base64 })
  }
  return out
}

export function toLDIF(batch: Batch): string {
  if (!batch.length) return ''
  const blocks = batch.map((e) => {
    const lines = [ldifLine('dn', e.dn, false), 'changetype: modify']
    for (const c of e.changes) {
      // Skip the whole change: a '-' without its operation line makes ldapmodify reject the record.
      if (!isAttrDescription(c.attr)) {
        lines.push(SKIPPED_NAME)
        continue
      }
      lines.push(`${c.op}: ${c.attr}`, ...c.values.map((v) => ldifLine(c.attr, v, !!c.base64)), '-')
    }
    return lines.map((l) => fold(l)).join('\n') + '\n'
  })
  return 'version: 1\n\n' + blocks.join('\n')
}

function validDN(v: string): boolean {
  // NameAndOptionalUID values may end in a #'0101'B bit string.
  const rdns = splitDN(v.replace(/#'[01]*'B$/, ''))
  return rdns.length > 0 && rdns.every(looksLikeDN)
}

/** The first rule the kept values break, in the documented order. */
export function problem(
  attr: string,
  kept: Value[],
  must: boolean,
  schema: SchemaIndex,
): string | undefined {
  const t = texts(kept)
  const all = (re: RegExp) => t.every((v) => re.test(v))
  const syntax = schema.syntax(attr)
  if (t.includes('')) return 'Empty values are not allowed'
  if (kept.length > 1 && schema.attr(attr)?.singleValue) return 'Single-valued: keep one value'
  if (syntax === SYNTAX_INTEGER && !all(/^-?\d+$/)) return 'Must be an integer'
  if (schema.isBoolean(attr) && !all(/^(TRUE|FALSE)$/)) return 'Must be TRUE or FALSE'
  // Without a schema isDN guesses from well-known names; only empties are checked then.
  if (schema.available && schema.isDN(attr) && !t.every(validDN)) return 'Not a valid DN'
  if (syntax === SYNTAX.generalizedTime && !all(GENERALIZED_TIME))
    return 'Must be a GeneralizedTime like 20261112093000Z'
  if (must && !kept.length) return 'Required by the object class'
  return undefined
}

/** Whether a staged entry fails validation; entries missing from cached are not checked. */
export function invalidBatch(batch: Batch, cached: Entry[], schema: SchemaIndex): boolean {
  return batch.some((ec) => {
    const e = cached.find((x) => sameDN(x.dn, ec.dn))
    return !!e && validate(e, ec, schema).size > 0
  })
}

/** Problems per touched attribute, keyed by attrKey, against the classes the entry will have. */
export function validate(
  entry: Entry,
  ec: EntryChanges | undefined,
  schema: SchemaIndex,
): Map<string, string> {
  const out = new Map<string, string>()
  const after = applied(entry, ec)
  const classes = texts(findAttr(after, 'objectClass')?.values)
  const { must, may } = schema.allowed(classes)
  // A MUST is met by a value of the attribute or of any variant with options (cn;lang-de for cn).
  const filled = (k: string) =>
    (after.attributes ?? []).some((a) => schema.key(a.name) === k && !!a.values?.length)
  const staged = unpack(ec)
  for (const s of staged) {
    const k = schema.key(s.attr)
    const kept = findAttr(after, s.attr)?.values ?? []
    const msg = problem(s.attr, kept, must.has(k) && !filled(k), schema)
    if (msg) out.set(attrKey(s.attr), msg)
  }
  for (const name of missingMust(entry, ec, schema))
    out.set(attrKey(name), 'Required by the object class')
  // A removed class leaves its attributes behind; the server refuses those no other class allows
  // (extensibleObject allows them all).
  const open = classes.some((c) => c.toLowerCase() === 'extensibleobject')
  const removed = open ? [] : texts(staged.find((s) => sameAttr(s.attr, 'objectClass'))?.del)
  for (const cls of removed) {
    const gone = schema.allowed([cls])
    for (const a of after.attributes ?? []) {
      const k = schema.key(a.name)
      if (!a.values?.length || out.has(attrKey(a.name)) || must.has(k) || may.has(k)) continue
      if (gone.must.has(k) || gone.may.has(k))
        out.set(attrKey(a.name), `Not allowed without ${cls}; delete it`)
    }
  }
  return out
}
