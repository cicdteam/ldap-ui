import type { Attribute, AttributeType, ContentRule, ObjectClass, Schema } from './types'

export const SYNTAX = {
  dn: '1.3.6.1.4.1.1466.115.121.1.12',
  nameAndUID: '1.3.6.1.4.1.1466.115.121.1.34',
  boolean: '1.3.6.1.4.1.1466.115.121.1.7',
  generalizedTime: '1.3.6.1.4.1.1466.115.121.1.24',
  jpeg: '1.3.6.1.4.1.1466.115.121.1.28',
}

// Used when the server publishes no schema.
const FALLBACK_DN = new Set([
  'member',
  'uniquemember',
  'memberof',
  'manager',
  'owner',
  'seealso',
  'distinguishedname',
  'secretary',
  'directreports',
  'managedby',
  'roleoccupant',
  'creatorsname',
  'modifiersname',
  'entrydn',
  'subschemasubentry',
])
const IMAGE_ATTRS = new Set(['jpegphoto', 'thumbnailphoto', 'photo'])

const lc = (s: string) => s.toLowerCase()

/** Lowercased attribute name without options (";binary", ";range=0-1499"). */
export function baseName(attr: string): string {
  return lc(attr.split(';')[0])
}

/**
 * An attribute as the batch tells attributes apart: its lowercased name and options, the options
 * sorted, without range= (an Active Directory read artifact). cn and cn;lang-de are two
 * attributes; schema lookups still go by baseName.
 */
export function attrKey(attr: string): string {
  const [name, ...options] = attr.toLowerCase().split(';')
  return [name, ...options.filter((o) => !o.startsWith('range=')).sort()].join(';')
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })

export class SchemaIndex {
  readonly available: boolean
  readonly attrNames: string[]
  readonly classNames: string[]
  private readonly attrs = new Map<string, AttributeType>()
  private readonly classes = new Map<string, ObjectClass>()
  private readonly rules = new Map<string, ContentRule>()

  constructor(s: Schema | undefined) {
    const types = s?.attributeTypes ?? []
    const classes = s?.objectClasses ?? []
    this.available = types.length > 0
    for (const a of types) {
      this.attrs.set(lc(a.oid), a)
      for (const n of a.names ?? []) this.attrs.set(lc(n), a)
    }
    for (const c of classes) {
      this.classes.set(lc(c.oid), c)
      for (const n of c.names ?? []) this.classes.set(lc(n), c)
    }
    for (const r of s?.contentRules ?? []) this.rules.set(lc(r.oid), r)
    this.attrNames = types.flatMap((a) => a.names ?? []).sort(byName)
    this.classNames = classes.flatMap((c) => c.names ?? []).sort(byName)
  }

  attr(name: string): AttributeType | undefined {
    return this.attrs.get(baseName(name))
  }

  objectClass(name: string): ObjectClass | undefined {
    return this.classes.get(lc(name))
  }

  /** Canonical key: the lowercased OID when known, else the lowercased name. */
  key(name: string): string {
    const a = this.attr(name)
    return a ? lc(a.oid) : baseName(name)
  }

  /** Effective syntax OID, inherited through SUP, without a {length} bound. */
  syntax(name: string): string {
    let a = this.attr(name)
    for (let depth = 0; a && depth < 16; depth++) {
      if (a.syntax) return a.syntax.replace(/\{\d+\}$/, '')
      a = a.sup ? this.attr(a.sup) : undefined
    }
    return ''
  }

  isDN(name: string): boolean {
    const s = this.syntax(name)
    if (!s) return FALLBACK_DN.has(baseName(name))
    return s === SYNTAX.dn || s === SYNTAX.nameAndUID
  }

  isBoolean(name: string): boolean {
    return this.syntax(name) === SYNTAX.boolean
  }

  isImage(name: string): boolean {
    return this.syntax(name) === SYNTAX.jpeg || IMAGE_ATTRS.has(baseName(name))
  }

  isOperational(name: string): boolean {
    const u = this.attr(name)?.usage
    return u !== undefined && u !== '' && u !== 'userApplications'
  }

  /** MUST and MAY keys for an entry's objectClass values, with SUP and DIT content rules. */
  allowed(objectClasses: string[]): { must: Set<string>; may: Set<string> } {
    const must = new Set<string>()
    const may = new Set<string>()
    const seen = new Set<string>()
    const add = (names: string[] | undefined, to: Set<string>) =>
      names?.forEach((n) => to.add(this.key(n)))
    // optional: reached through a content rule's AUX list, so its MUST is only allowed.
    const visit = (name: string, optional: boolean) => {
      const oc = this.objectClass(name)
      if (!oc) return
      const mark = `${oc.oid}:${optional}`
      if (seen.has(mark)) return
      seen.add(mark)
      add(oc.must, optional ? may : must)
      add(oc.may, may)
      oc.sup?.forEach((s) => visit(s, optional))
      const rule = this.rules.get(lc(oc.oid))
      if (rule) {
        add(rule.must, optional ? may : must)
        add(rule.may, may)
        rule.aux?.forEach((x) => visit(x, true))
      }
    }
    objectClasses.forEach((c) => visit(c, false))
    for (const k of must) may.delete(k)
    return { must, may }
  }
}

export interface Grouped {
  must: Attribute[]
  may: Attribute[]
  operational: Attribute[]
}

function sortAttrs(list: Attribute[]): Attribute[] {
  return [...list].sort((a, b) => {
    const ao = baseName(a.name) === 'objectclass'
    const bo = baseName(b.name) === 'objectclass'
    if (ao !== bo) return ao ? -1 : 1
    return byName(a.name, b.name)
  })
}

/**
 * Splits an entry's attributes for the inspector. Attributes neither MUST nor
 * MAY for the entry's classes (AD constructed and system attributes) count as
 * operational. Without a schema everything goes to MAY.
 */
export function groupAttributes(attrs: Attribute[], idx: SchemaIndex): Grouped {
  if (!idx.available) return { must: [], may: sortAttrs(attrs), operational: [] }
  const ocs =
    attrs.find((a) => baseName(a.name) === 'objectclass')?.values?.map((v) => v.text) ?? []
  const { must, may } = idx.allowed(ocs)
  const g: Grouped = { must: [], may: [], operational: [] }
  for (const a of attrs) {
    const k = idx.key(a.name)
    if (idx.isOperational(a.name)) g.operational.push(a)
    else if (must.has(k)) g.must.push(a)
    else if (may.has(k)) g.may.push(a)
    else g.operational.push(a)
  }
  return { must: sortAttrs(g.must), may: sortAttrs(g.may), operational: sortAttrs(g.operational) }
}

/** Tooltip text for an attribute name. */
export function attributeHelp(name: string, idx: SchemaIndex): string {
  const a = idx.attr(name)
  if (!a) return `${name}: not in the schema`
  const head = a.desc ? `${name}: ${a.desc}` : name
  const parts = [`OID ${a.oid}`]
  const syntax = idx.syntax(name)
  if (syntax) parts.push(`syntax ${syntax}`)
  if (a.singleValue) parts.push('single-value')
  return `${head}\n${parts.join(', ')}`
}
