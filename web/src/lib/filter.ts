// RFC 4515 search filters. Whitespace is accepted between components (so the
// indented form from format() parses), never inside an item. Values keep their
// escaped form, which makes parse -> serialize lossless.

export type CmpOp = '=' | '~=' | '>=' | '<=' | ':='

export type Filter =
  | { type: 'and' | 'or'; children: Filter[] }
  | { type: 'not'; child: Filter }
  | { type: 'cmp'; attr: string; op: CmpOp; value: string }

export type Group = Extract<Filter, { type: 'and' | 'or' }>

export interface ParseError {
  from: number
  to: number
  message: string
}

export type ParseResult = { ok: true; filter: Filter } | { ok: false; error: ParseError }

const ATTR = /^(?:[A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)*)(?:;[A-Za-z0-9-]+)*$/
const EXT_ATTR =
  /^(?:(?:[A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)*)(?:;[A-Za-z0-9-]+)*)?(?::dn)?(?::(?:[A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)*))?$/i

// The server's limit (internal/ldapx maxFilterDepth); it also keeps the
// recursive descent far from the JS stack limit on pasted input.
const MAX_DEPTH = 64

class Failure {
  constructor(readonly error: ParseError) {}
}

class Parser {
  i = 0
  constructor(readonly s: string) {}

  fail(from: number, to: number, message: string): never {
    const f = Math.min(from, this.s.length)
    throw new Failure({ from: f, to: Math.min(Math.max(to, f), this.s.length), message })
  }

  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++
  }

  filter(depth = 1): Filter {
    if (this.s[this.i] !== '(') this.fail(this.i, this.i + 1, 'expected (')
    if (depth > MAX_DEPTH) {
      this.fail(this.i, this.i + 1, `filter nests deeper than ${MAX_DEPTH} levels`)
    }
    const open = this.i++
    let f: Filter
    const ch = this.s[this.i]
    if (ch === '&' || ch === '|') {
      this.i++
      const children: Filter[] = []
      this.ws()
      while (this.s[this.i] === '(') {
        children.push(this.filter(depth + 1))
        this.ws()
      }
      f = { type: ch === '&' ? 'and' : 'or', children }
    } else if (ch === '!') {
      this.i++
      this.ws()
      if (this.i >= this.s.length) this.fail(open, open + 1, 'unclosed (')
      f = { type: 'not', child: this.filter(depth + 1) }
      this.ws()
    } else {
      f = this.item(true)
    }
    if (this.i >= this.s.length) this.fail(open, open + 1, 'unclosed (')
    if (this.s[this.i] !== ')') this.fail(this.i, this.i + 1, 'expected )')
    this.i++
    return f
  }

  /** inParens: the item ends at ')'; otherwise it is a bare item running to the end. */
  item(inParens: boolean): Filter {
    const s = this.s
    const start = this.i
    let j = start
    while (j < s.length && s[j] !== '=' && s[j] !== '(' && s[j] !== ')') j++
    if (s[j] !== '=') {
      if (inParens && j >= s.length) this.fail(start - 1, start, 'unclosed (')
      this.fail(start, j, 'expected attribute=value')
    }
    let op: CmpOp = '='
    let attrEnd = j
    const prev = s[j - 1]
    if (j > start && (prev === '~' || prev === '>' || prev === '<' || prev === ':')) {
      op = `${prev}=` as CmpOp
      attrEnd = j - 1
    }
    const attr = s.slice(start, attrEnd)
    const valid =
      op === ':=' ? attr !== '' && !/^:dn$/i.test(attr) && EXT_ATTR.test(attr) : ATTR.test(attr)
    if (!valid) {
      this.fail(
        start,
        Math.max(attrEnd, start + 1),
        attr === '' ? 'missing attribute name' : `invalid attribute "${attr}"`,
      )
    }
    let k = j + 1
    while (k < s.length && !(inParens && s[k] === ')')) {
      const c = s[k]
      if (c === '(') this.fail(k, k + 1, 'unescaped ( in value, write \\28')
      if (c === ')') this.fail(k, k + 1, 'unescaped ) in value, write \\29')
      if (c === '\\') {
        if (!/^[0-9a-fA-F]{2}$/.test(s.slice(k + 1, k + 3)))
          this.fail(k, k + 3, 'invalid escape, use \\ and two hex digits')
        k += 3
        continue
      }
      if (c === '*' && op !== '=') this.fail(k, k + 1, '* is only allowed with =')
      k++
    }
    this.i = k
    return { type: 'cmp', attr, op, value: s.slice(j + 1, k) }
  }
}

export function parse(text: string): ParseResult {
  const s = text.trimEnd()
  const lead = s.length - s.trimStart().length
  if (s.trim() === '')
    return { ok: false, error: { from: 0, to: text.length, message: 'empty filter' } }
  const p = new Parser(s)
  p.i = lead
  try {
    const filter = s[lead] === '(' ? p.filter() : p.item(false)
    p.ws()
    if (p.i < s.length) p.fail(p.i, s.length, 'unexpected text after filter')
    return { ok: true, filter }
  } catch (e) {
    if (e instanceof Failure) return { ok: false, error: e.error }
    throw e
  }
}

export function serialize(f: Filter): string {
  switch (f.type) {
    case 'and':
      return `(&${f.children.map(serialize).join('')})`
    case 'or':
      return `(|${f.children.map(serialize).join('')})`
    case 'not':
      return `(!${serialize(f.child)})`
    case 'cmp':
      return `(${f.attr}${f.op}${f.value})`
  }
}

/** Pretty form: anything longer than 72 columns is split one component per line. */
export function format(f: Filter, indent = ''): string {
  const flat = serialize(f)
  if (f.type === 'cmp' || indent.length + flat.length <= 72) return indent + flat
  const inner = indent + '  '
  if (f.type === 'not') return `${indent}(!\n${format(f.child, inner)}\n${indent})`
  const op = f.type === 'and' ? '&' : '|'
  return `${indent}(${op}\n${f.children.map((c) => format(c, inner)).join('\n')}\n${indent})`
}

/** Escapes a literal for use as an assertion value. */
export function escapeValue(v: string): string {
  return v.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'))
}

/** The builder always edits a group; a lone item is shown inside an implicit AND. */
export function toGroup(f: Filter): Group {
  return f.type === 'and' || f.type === 'or' ? f : { type: 'and', children: [f] }
}

export function fromGroup(g: Group): Filter {
  return g.type === 'and' && g.children.length === 1 ? g.children[0] : g
}

/** The Cmd+K "find entry by name" filter, working on OpenLDAP and AD. */
export function nameFilter(q: string): string {
  const v = escapeValue(q.trim())
  return `(|(cn=*${v}*)(uid=${v}*)(sAMAccountName=${v}*)(mail=${v}*)(displayName=*${v}*))`
}

export interface CompletionOption {
  label: string
  detail?: string
}

export interface FilterCompletion {
  from: number
  options: CompletionOption[]
}

export const OPERATORS: CompletionOption[] = [
  { label: '=', detail: 'equals' },
  { label: '=*', detail: 'present' },
  { label: '>=', detail: 'greater or equal' },
  { label: '<=', detail: 'less or equal' },
  { label: '~=', detail: 'approximately' },
]

/**
 * Completion for the text before the cursor: attribute names after "(",
 * operators after a complete attribute name, objectClass names as values.
 */
export function completeFilter(
  before: string,
  attrNames: string[],
  classNames: string[],
): FilterCompletion | null {
  const value = /\(([A-Za-z][A-Za-z0-9;-]*)(?:~=|>=|<=|=)([^()]*)$/.exec(before)
  if (value) {
    const [, attr, typed] = value
    if (attr.toLowerCase() !== 'objectclass') return null
    const t = typed.toLowerCase()
    return {
      from: before.length - typed.length,
      options: classNames.filter((n) => n.toLowerCase().startsWith(t)).map((label) => ({ label })),
    }
  }
  const name = /(?:^|\()([A-Za-z0-9;-]*)$/.exec(before)
  if (!name) return null
  const typed = name[1]
  const t = typed.toLowerCase()
  if (typed && attrNames.some((n) => n.toLowerCase() === t))
    return { from: before.length, options: OPERATORS }
  return {
    from: before.length - typed.length,
    options: attrNames.filter((n) => n.toLowerCase().startsWith(t)).map((label) => ({ label })),
  }
}
