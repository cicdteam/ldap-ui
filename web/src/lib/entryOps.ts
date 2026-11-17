import { needsBinaryOption, withBinaryOption } from './binary'
import { problem, touchedAttributes, type Batch } from './changes'
import { isUnder, looksLikeDN, parentDN, rdnType, sameDN, splitDN } from './dn'
import { isRDNValue, isSecret, lockReason, structuralClass } from './edit'
import { base64UTF8, fold, ldifLine } from './ldif'
import { attrKey, baseName, type SchemaIndex } from './schema'
import type { Entry, TextAttribute } from './types'

/** One attribute row of the create form; a '' value is a blank field and is never sent. */
export interface FormAttr {
  name: string
  values: string[]
  /** Binary values, standard base64 (uploaded files, or cloned). */
  binary?: string[]
}

/** The New child and Clone form. */
export interface EntryForm {
  parent: string
  /** The structural class first, then auxiliary ones in the order chosen. */
  classes: string[]
  rdnAttr: string
  rdnValue: string
  /** Attribute rows; objectClass is never one. */
  attrs: FormAttr[]
}

// Values that identify one entry: a clone leaves them out (spec 4.3; lowercased). Certificates
// (one person's key) and AD's mS-DS-ConsistencyGuid (one cloud identity) go too: by certificate
// syntax, and by name where the syntax is octet string or binary (AD, userSMIMECertificate). So
// do authentication bindings (SSH keys, certificate and key credential mappings, Kerberos
// principals), which would let the clone sign in as the source, and FreeIPA's ipaUniqueID.
const CLONE_SKIP = new Set([
  'uid',
  'mail',
  'uidnumber',
  'employeenumber',
  'samaccountname',
  'userprincipalname',
  'objectguid',
  'objectsid',
  'usercertificate',
  'usersmimecertificate',
  'ms-ds-consistencyguid',
  'sshpublickey',
  'ipasshpubkey',
  'altsecurityidentities',
  'msds-keycredentiallink',
  'serviceprincipalname',
  'krbprincipalname',
  'krbcanonicalname',
  'ipauniqueid',
])

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })
const sameName = (a: string, b: string) => attrKey(a) === attrKey(b)

/** Attribute names (schema spelling) for keys a form may hold, sorted: never objectClass or a locked one. */
function formNames(keys: Iterable<string>, schema: SchemaIndex): string[] {
  return [...keys]
    .map((k) => schema.attr(k)?.names?.[0] ?? k)
    .filter((n) => baseName(n) !== 'objectclass' && !lockReason(n, schema))
    .sort(byName)
}

/** RFC 4514 escaping of a value for a DN: specials, a leading space or #, a trailing space. */
export function escapeRDNValue(v: string): string {
  const chars = Array.from(v)
  return chars
    .map((ch, i) => {
      const edge = (i === 0 && (ch === ' ' || ch === '#')) || (i === chars.length - 1 && ch === ' ')
      return edge || '\\,+"<>;'.includes(ch) ? '\\' + ch : ch
    })
    .join('')
}

/** The DN the form creates. */
export function formDN(f: EntryForm): string {
  const rdn = `${f.rdnAttr.trim()}=${escapeRDNValue(f.rdnValue.trim())}`
  const parent = f.parent.trim()
  return parent ? `${rdn},${parent}` : rdn
}

/**
 * The RDN attribute a new entry of classes gets by default: ou for an OU, cn on Active Directory
 * (ad), which names users, groups and contacts by cn, else uid where allowed, else cn.
 */
export function defaultRDNAttr(classes: string[], schema: SchemaIndex, ad = false): string {
  if (classes.some((c) => c.toLowerCase() === 'organizationalunit')) return 'ou'
  if (ad) return 'cn'
  const { must, may } = schema.allowed(classes)
  const uid = schema.key('uid')
  return must.has(uid) || may.has(uid) ? 'uid' : 'cn'
}

/**
 * Attributes the RDN may use: the MUST and MAY attributes of classes, without top's MUSTs, which
 * the server sets on Active Directory (nTSecurityDescriptor, objectCategory, instanceType).
 */
export function rdnChoices(classes: string[], schema: SchemaIndex): string[] {
  const { must, may } = schema.allowed(classes)
  const top = schema.allowed(['top']).must
  return formNames(
    [...must, ...may].filter((k) => !top.has(k)),
    schema,
  )
}

/**
 * Schema keys of the form's rows of attributes themselves: a variant with options (cn;lang-de) is
 * not one, a row with only ;binary, a transfer option (RFC 4522), is.
 */
function rowKeys(f: EntryForm, schema: SchemaIndex): Set<string> {
  const plain = (n: string) => [baseName(n), `${baseName(n)};binary`].includes(attrKey(n))
  return new Set(f.attrs.filter((a) => plain(a.name)).map((a) => schema.key(a.name)))
}

/** MUST and MAY attributes of the form's classes it has no row for; certificates as name;binary. */
export function addableToForm(f: EntryForm, schema: SchemaIndex): string[] {
  const have = rowKeys(f, schema)
  return rdnChoices(f.classes, schema)
    .filter((n) => !have.has(schema.key(n)))
    .map((n) => (needsBinaryOption(n, schema) ? withBinaryOption(n) : n))
}

/**
 * The MUST keys a new entry of classes asks for: those of top left out. AD's top requires
 * nTSecurityDescriptor, objectCategory and instanceType, which the server sets; OpenLDAP's
 * requires objectClass, which the form sends in any case.
 */
export function formMust(classes: string[], schema: SchemaIndex): Set<string> {
  const top = schema.allowed(['top']).must
  return new Set([...schema.allowed(classes).must].filter((k) => !top.has(k)))
}

/** Whether a row of name is required by must (see formMust): a variant with options never is. */
export function isMustRow(name: string, must: Set<string>, schema: SchemaIndex): boolean {
  return attrKey(name) === baseName(name) && must.has(schema.key(name))
}

/** f with a blank row for every MUST attribute of its classes that has none. */
function withMustRows(f: EntryForm, schema: SchemaIndex): EntryForm {
  const have = rowKeys(f, schema)
  const add = formNames(formMust(f.classes, schema), schema).filter((n) => !have.has(schema.key(n)))
  return { ...f, attrs: [...f.attrs, ...add.map((name) => ({ name, values: [] }))] }
}

/**
 * f for other classes: the rows that hold a value and a row per MUST. An RDN attribute other than
 * the old classes' default (a chosen or cloned one) stays while the new classes allow it, so it
 * survives an auxiliary class; a default one moves to the new classes' default (ad: on Active
 * Directory, see defaultRDNAttr).
 */
export function withClasses(
  f: EntryForm,
  classes: string[],
  schema: SchemaIndex,
  ad = false,
): EntryForm {
  const attrs = f.attrs.filter((a) => a.values.some((v) => v !== '') || !!a.binary?.length)
  const k = schema.key(f.rdnAttr)
  const keep =
    k !== schema.key(defaultRDNAttr(f.classes, schema, ad)) &&
    rdnChoices(classes, schema).some((n) => schema.key(n) === k)
  const rdnAttr = keep ? f.rdnAttr : defaultRDNAttr(classes, schema, ad)
  return withMustRows({ ...f, classes, rdnAttr, attrs }, schema)
}

/** An empty New child form under parent. */
export function newChildForm(parent: string, schema: SchemaIndex): EntryForm {
  return withClasses({ parent, classes: [], rdnAttr: '', rdnValue: '', attrs: [] }, [], schema)
}

/**
 * The Clone form for source, the entry with its staged changes applied: its parent, its classes
 * (the structural one first), its RDN attribute with no value, and the values that may repeat,
 * binary ones included, certificates not.
 */
export function cloneForm(source: Entry, schema: SchemaIndex): EntryForm {
  const type = rdnType(splitDN(splitDN(source.dn)[0] ?? '', '+')[0] ?? '')
  // In schema spelling, so the Structural class select finds its option.
  const all = (
    source.attributes?.find((a) => baseName(a.name) === 'objectclass')?.values ?? []
  ).map((v) => schema.objectClass(v.text)?.names?.[0] ?? v.text)
  const structural = structuralClass(all, schema)
  const classes = structural
    ? [structural, ...all.filter((c) => schema.objectClass(c)?.kind === 'AUXILIARY')]
    : all
  const attrs: FormAttr[] = []
  for (const a of source.attributes ?? []) {
    const k = baseName(a.name)
    const skip =
      CLONE_SKIP.has(k) || needsBinaryOption(a.name, schema) || lockReason(a.name, schema)
    if (k === 'objectclass' || skip) continue
    const kept = (a.values ?? []).filter((v) => v.base64 || !isRDNValue(source.dn, a.name, v.text))
    const values = kept.filter((v) => !v.base64).map((v) => v.text)
    const binary = kept.filter((v) => v.base64).map((v) => v.text)
    if (binary.length) attrs.push({ name: a.name, values, binary })
    else if (values.length) attrs.push({ name: a.name, values })
  }
  const rdnAttr = schema.attr(type)?.names?.[0] ?? type
  return withMustRows(
    { parent: parentDN(source.dn), classes, rdnAttr, rdnValue: '', attrs },
    schema,
  )
}

/**
 * The attributes the add request sends: objectClass first, then the RDN attribute when no row is
 * it, then the rows. Blank values are left out, rows of one attribute merge, and the RDN value
 * joins its attribute unless it is there in any case. Attributes left without values go.
 */
export function addAttributes(f: EntryForm): TextAttribute[] {
  const out: TextAttribute[] = [{ name: 'objectClass', values: [...f.classes] }]
  const find = (name: string) => out.find((a) => sameName(a.name, name))
  const rdnAttr = f.rdnAttr.trim()
  const rdnValue = f.rdnValue.trim()
  if (rdnAttr && !f.attrs.some((a) => sameName(a.name, rdnAttr)))
    out.push({ name: rdnAttr, values: [] })
  for (const row of f.attrs) {
    let a = find(row.name)
    if (!a) out.push((a = { name: row.name, values: [] }))
    for (const v of row.values) if (v !== '' && !a.values.includes(v)) a.values.push(v)
  }
  const r = rdnAttr ? find(rdnAttr) : undefined
  if (r && rdnValue && !r.values.some((v) => v.toLowerCase() === rdnValue.toLowerCase()))
    r.values.push(rdnValue)
  // Deviation (D6): an attribute with a binary value goes all in base64, its text values as
  // UTF-8: one attribute, one encoding, and the server refuses an attribute listed twice.
  for (const row of f.attrs) {
    const a = find(row.name)
    if (!a || !row.binary?.length) continue
    if (!a.base64) Object.assign(a, { values: a.values.map(base64UTF8), base64: true })
    for (const b of row.binary) if (!a.values.includes(b)) a.values.push(b)
  }
  return out.filter((a) => a.values.length > 0)
}

/**
 * Problems of what the form sends, per attribute (keyed by attrKey), by the batch's rules; a
 * locked name (a secret typed without a schema) is one.
 */
export function formProblems(f: EntryForm, schema: SchemaIndex): Map<string, string> {
  const out = new Map<string, string>()
  const sent = addAttributes(f)
  const must = formMust(f.classes, schema)
  for (const name of [...f.attrs.map((a) => a.name), ...sent.map((a) => a.name), f.rdnAttr]) {
    const k = attrKey(name)
    if (k === 'objectclass' || out.has(k)) continue
    const found = sent.find((a) => sameName(a.name, name))
    const values = (found?.values ?? []).map((text) => ({ text, base64: found?.base64 }))
    // The RDN value fills its attribute; an empty RDN value keeps Create off on its own. A value
    // of any variant with options (cn;lang-de for cn) meets the MUST too.
    const key = schema.key(name)
    const required =
      must.has(key) && !sameName(name, f.rdnAttr) && !sent.some((a) => schema.key(a.name) === key)
    const msg = lockReason(name, schema) || problem(name, values, required, schema)
    if (msg) out.set(k, msg)
  }
  return out
}

/** Whether Create may run: a parent, a class, an RDN, and no problem. */
export function canCreate(f: EntryForm, schema: SchemaIndex): boolean {
  return (
    looksLikeDN(f.parent) &&
    f.rdnAttr.trim() !== '' &&
    f.rdnValue.trim() !== '' &&
    f.classes.length > 0 &&
    formProblems(f, schema).size === 0
  )
}

/** Staged changes (attributes, as the header counts them) of dn and the entries below it. */
export function stagedUnder(batch: Batch, dn: string): number {
  return touchedAttributes(batch.filter((e) => isUnder(e.dn, dn)))
}

/** Why Rename/Move and Delete wait; '' when nothing is staged. */
export function stagedHint(n: number): string {
  return n ? `Apply or discard ${n} staged ${n === 1 ? 'change' : 'changes'} first` : ''
}

/** The DN a rename gives. */
export function renameTarget(newRDN: string, newParent: string): string {
  return `${newRDN.trim()},${newParent.trim()}`
}

/** Why the rename cannot run, '' when it can. */
export function renameProblem(
  dn: string,
  newRDN: string,
  newParent: string,
  schema: SchemaIndex,
): string {
  const rdn = newRDN.trim()
  if (!looksLikeDN(rdn) || splitDN(rdn).length !== 1) return 'The new RDN must look like cn=Name'
  // The new RDN value is written to the entry, and the server logs the new DN.
  const secret = splitDN(rdn, '+')
    .map((p) => rdnType(p).trim())
    .find((t) => isSecret(t, schema))
  if (secret) return `${secret} is secret and cannot name an entry`
  if (!looksLikeDN(newParent)) return 'The new parent must be a DN'
  if (isUnder(newParent, dn)) return 'An entry cannot move below itself'
  // Case-only renames (cn=john to cn=John) are allowed: the RDN compares exactly.
  if (sameDN(renameTarget(rdn, newParent), dn) && rdn === splitDN(dn)[0]?.trim())
    return 'The new DN is the current one'
  return ''
}

function ldif(dn: string, lines: string[]): string {
  return (
    'version: 1\n\n' + [ldifLine('dn', dn, false), ...lines].map((l) => fold(l)).join('\n') + '\n'
  )
}

export function addLDIF(dn: string, attrs: TextAttribute[]): string {
  return ldif(dn, [
    'changetype: add',
    ...attrs.flatMap((a) => a.values.map((v) => ldifLine(a.name, v, !!a.base64))),
  ])
}

export function deleteLDIF(dn: string): string {
  return ldif(dn, ['changetype: delete'])
}

/** modrdn LDIF; newParent only when the entry moves. */
export function renameLDIF(
  dn: string,
  newRDN: string,
  newParent: string | undefined,
  deleteOld: boolean,
): string {
  return ldif(dn, [
    'changetype: modrdn',
    ldifLine('newrdn', newRDN, false),
    `deleteoldrdn: ${deleteOld ? 1 : 0}`,
    ...(newParent ? [ldifLine('newsuperior', newParent, false)] : []),
  ])
}

/** What blocks a delete: the entry's children, counted by a search capped at 101. */
export function childrenNote(n: number): string {
  if (n === 0) return ''
  if (n === 1) return 'Has 1 child. Delete it first.'
  return `Has ${n > 100 ? '100+' : n} children. Delete them first.`
}

/**
 * Whether Set password applies to entry: its classes allow userPassword, or on Active Directory
 * (ad) it is a user, whose password the server writes as unicodePwd.
 */
export function canSetPassword(entry: Entry, schema: SchemaIndex, ad: boolean): boolean {
  const classes = (
    entry.attributes?.find((a) => baseName(a.name) === 'objectclass')?.values ?? []
  ).map((v) => v.text)
  // AD's person allows userPassword too, but a contact has no unicodePwd.
  if (ad) return classes.some((c) => c.toLowerCase() === 'user')
  const { must, may } = schema.allowed(classes)
  const k = schema.key('userPassword')
  return must.has(k) || may.has(k)
}

/** Why a new password typed twice cannot be set, '' when it can; nothing is trimmed. */
export function passwordProblem(password: string, repeat: string): string {
  if (password === '') return 'Enter a password'
  return password === repeat ? '' : 'Passwords do not match'
}
