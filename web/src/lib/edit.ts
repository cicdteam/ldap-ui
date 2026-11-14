import { needsBinaryOption, withBinaryOption } from './binary'
import type { MarkedValue } from './changes'
import { rdnType, rdnValue, splitDN } from './dn'
import { attrKey, baseName, SYNTAX, type SchemaIndex } from './schema'
import type { Entry } from './types'

export type EditorKind = 'text' | 'multiline' | 'dn' | 'boolean' | 'time'

// Client copy of secretAttributes in internal/ldapx/entry.go: the server
// refuses to write them, so the UI does not offer to.
const SECRETS = new Set([
  'userpassword',
  'unicodepwd',
  'sambantpassword',
  'sambalmpassword',
  'authpassword',
  'supplementalcredentials',
  'dbcspwd',
  'ntpwdhistory',
  'lmpwdhistory',
  'pwdhistory',
  'sambapasswordhistory',
  'krbprincipalkey',
  'ipanthash',
  'ms-mcs-admpwd',
  'mslaps-password',
  'mslaps-encryptedpassword',
  'mslaps-encryptedpasswordhistory',
  'mslaps-encrypteddsrmpassword',
  'mslaps-encrypteddsrmpasswordhistory',
  'msds-managedpassword',
  'msfve-recoverypassword',
  'mstpm-ownerinformation',
  'userpkcs12',
  '2.5.4.35',
  '1.3.6.1.4.1.7165.2.1.24',
  '1.3.6.1.4.1.7165.2.1.25',
  '1.3.6.1.4.1.4203.1.3.4',
  '1.2.840.113556.1.4.90',
  '1.2.840.113556.1.4.55',
  '1.2.840.113556.1.4.94',
  '1.2.840.113556.1.4.160',
  '1.2.840.113556.1.4.125',
])

// YYYYMMDDHHMM, optional SS with an optional fraction, UTC only.
const GENERALIZED_TIME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(?:(\d{2})(?:[.,]\d+)?)?Z$/

/** Whether attr is a secret (a password or key), by name or by the OID the schema gives it. */
export function isSecret(attr: string, schema: SchemaIndex): boolean {
  // LDAPv2 spelled OIDs as "OID.2.5.4.35"; servers still take that in a DN.
  const name = attr.replace(/^oid\./i, '')
  const type = schema.attr(name)
  return SECRETS.has(baseName(name)) || (!!type && SECRETS.has(type.oid.toLowerCase()))
}

/** '' when the attribute can be edited, else why not (shown as a tooltip). */
export function lockReason(attr: string, schema: SchemaIndex): string {
  const base = baseName(attr)
  const type = schema.attr(attr)
  // Classes are edited against the schema, which tells structural from auxiliary.
  if (base === 'objectclass')
    return schema.available ? '' : 'objectClass is edited only with a schema'
  if (isSecret(attr, schema)) return 'Secret attributes cannot be edited here'
  if (schema.isOperational(attr) || type?.noUserModification) return 'Set by the server'
  return ''
}

export function editorKind(attr: string, value: string, schema: SchemaIndex): EditorKind {
  if (schema.isBoolean(attr)) return 'boolean'
  if (schema.syntax(attr) === SYNTAX.generalizedTime)
    return value === '' || timeToLocalInput(value) !== '' ? 'time' : 'text'
  if (schema.isDN(attr)) return 'dn'
  return value.includes('\n') ? 'multiline' : 'text'
}

/** True when value is the RDN value of dn for attr (cannot be deleted in 3a). */
export function isRDNValue(dn: string, attr: string, value: string): boolean {
  // Lowercased: RDN types are case-ignore in practice, so "B" and "b" are one value.
  return splitDN(splitDN(dn)[0] ?? '', '+').some(
    (ava) =>
      attrKey(rdnType(ava)) === attrKey(attr) &&
      rdnValue(ava).toLowerCase() === value.toLowerCase(),
  )
}

/** GeneralizedTime ("20261112093000Z", UTC only) -> datetime-local ("2026-11-12T09:30:00"); '' if not convertible. */
export function timeToLocalInput(v: string): string {
  const m = GENERALIZED_TIME.exec(v)
  if (!m) return ''
  const [, y, mo, d, h, mi, s = '00'] = m
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`
}

/** datetime-local -> GeneralizedTime UTC ("...Z"). */
export function localInputToTime(v: string): string {
  if (!v) return ''
  const t = v.split('.')[0].replace(/[-:T]/g, '')
  return `${t.length === 12 ? t + '00' : t}Z`
}

/** The entry's objectClass values, those staged for delete left out: they allow nothing new. */
function liveClasses(entry: Entry): string[] {
  return (entry.attributes?.find((a) => baseName(a.name) === 'objectclass')?.values ?? [])
    .filter((v) => (v as MarkedValue).mark !== 'deleted')
    .map((v) => v.text)
}

/**
 * MUST/MAY attribute names (schema spelling) the entry (a staged view) has no attribute for,
 * sorted; certificates as name;binary. An attribute with options (description;lang-ru) leaves the
 * plain name on offer.
 */
export function addableAttributes(entry: Entry, schema: SchemaIndex): string[] {
  if (!schema.available) return []
  const { must, may } = schema.allowed(liveClasses(entry))
  // The schema key with the options: commonName;LANG-DE is cn;lang-de.
  const full = (n: string) => schema.key(n) + attrKey(n).slice(baseName(n).length)
  const have = new Set((entry.attributes ?? []).map((a) => full(a.name)))
  return [...must, ...may]
    .map((k) => schema.attr(k)?.names?.[0] ?? k)
    .map((n) => (needsBinaryOption(n, schema) ? withBinaryOption(n) : n))
    .filter((n) => !have.has(full(n)) && !lockReason(n, schema))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

const OPTION = /^[a-z0-9-]+$/i

/**
 * Why "+ attribute" cannot add name to entry (a staged view), '' when it can: options are letters,
 * digits and hyphens (so never range=), the entry has no such attribute yet, it is not locked, and
 * with a schema the entry's classes allow its type.
 */
export function addAttributeProblem(name: string, entry: Entry, schema: SchemaIndex): string {
  const [base, ...options] = name.split(';')
  if (!base || !options.every((o) => OPTION.test(o)))
    return 'Options are letters, digits and hyphens, as in cn;lang-de'
  if (entry.attributes?.some((a) => attrKey(a.name) === attrKey(name)))
    return `${name} is already there: add a value to it`
  const lock = lockReason(name, schema)
  if (lock) return lock
  if (!schema.available) return ''
  const { must, may } = schema.allowed(liveClasses(entry))
  const k = schema.key(name)
  return must.has(k) || may.has(k) ? '' : `The entry's classes do not allow ${base}`
}

const STRUCTURAL = 'Structural class cannot be changed'
const COMMON = ['inetOrgPerson', 'organizationalUnit', 'groupOfNames', 'posixGroup']
const COMMON_AD = ['user', 'group', 'organizationalUnit', 'contact']

/** '' when an objectClass value can be removed (an auxiliary class), else why not. */
export function classLock(cls: string, schema: SchemaIndex): string {
  // The structural class, its superclasses and top are never auxiliary; an unknown class stays too.
  return schema.objectClass(cls)?.kind === 'AUXILIARY' ? '' : STRUCTURAL
}

/** Classes of kind (first schema name only, so aliases appear once), in classNames order. */
function classesOfKind(schema: SchemaIndex, kind: 'STRUCTURAL' | 'AUXILIARY'): string[] {
  return schema.classNames.filter((n) => {
    const oc = schema.objectClass(n)
    return oc?.kind === kind && oc.names?.[0] === n
  })
}

/** AUXILIARY classes (first schema name) not among classes, sorted. */
export function auxiliaryCandidates(classes: string[], schema: SchemaIndex): string[] {
  const have = new Set(classes.map((c) => schema.objectClass(c)?.oid ?? c.toLowerCase()))
  return classesOfKind(schema, 'AUXILIARY').filter(
    (n) => !have.has(schema.objectClass(n)?.oid ?? ''),
  )
}

/** STRUCTURAL classes for a new entry: the common ones the schema has first, then the rest, sorted. */
export function structuralChoices(schema: SchemaIndex, ad: boolean): string[] {
  const all = classesOfKind(schema, 'STRUCTURAL')
  const common = (ad ? COMMON_AD : COMMON).flatMap((c) =>
    all.filter((n) => n.toLowerCase() === c.toLowerCase()),
  )
  return [...common, ...all.filter((n) => !common.includes(n))]
}

/** OIDs of every superclass of cls. */
function superclasses(cls: string, schema: SchemaIndex): Set<string> {
  const out = new Set<string>()
  const walk = (name: string) => {
    for (const s of schema.objectClass(name)?.sup ?? []) {
      const sup = schema.objectClass(s)
      if (sup && !out.has(sup.oid)) {
        out.add(sup.oid)
        walk(s)
      }
    }
  }
  walk(cls)
  return out
}

/** The entry's structural class: the STRUCTURAL value no other value inherits from; '' if none. */
export function structuralClass(classes: string[], schema: SchemaIndex): string {
  const structural = classes.filter((c) => schema.objectClass(c)?.kind === 'STRUCTURAL')
  const oid = (c: string) => schema.objectClass(c)?.oid ?? ''
  return (
    structural.find(
      (c) => !structural.some((o) => o !== c && superclasses(o, schema).has(oid(c))),
    ) ?? ''
  )
}
