import { describe, expect, it } from 'vitest'
import {
  completeFilter,
  escapeValue,
  format,
  fromGroup,
  nameFilter,
  parse,
  serialize,
  toGroup,
  type Filter,
} from './filter'

function ok(text: string): Filter {
  const r = parse(text)
  if (!r.ok) throw new Error(`parse(${text}) failed: ${r.error.message}`)
  return r.filter
}

const canonical = [
  '(objectClass=*)',
  '(cn=John*)',
  '(cn=*oh*n)',
  '(cn=)',
  '(uidNumber>=1000)',
  '(uidNumber<=2000)',
  '(cn~=jon)',
  '(cn;lang-en=x)',
  '(2.5.4.3=x)',
  '(cn:dn:2.5.13.5:=John)',
  '(:dn:2.5.13.5:=John)',
  '(userAccountControl:1.2.840.113556.1.4.803:=2)',
  '(cn=a\\28b\\29\\2a\\5c)',
  '(cn=Jürgen Müller)',
  '(cn=with space)',
  '(&)',
  '(|)',
  '(!(cn=x))',
  '(&(objectClass=person)(|(uid=a)(uid=b))(!(mail=*)))',
  '(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))',
]

describe('parse/serialize', () => {
  it.each(canonical)('round-trips %s', (text) => {
    expect(serialize(ok(text))).toBe(text)
  })

  it('builds the AST', () => {
    expect(ok('(&(cn=a)(!(sn>=b)))')).toEqual({
      type: 'and',
      children: [
        { type: 'cmp', attr: 'cn', op: '=', value: 'a' },
        { type: 'not', child: { type: 'cmp', attr: 'sn', op: '>=', value: 'b' } },
      ],
    })
  })

  it('accepts a bare item and surrounding whitespace', () => {
    expect(serialize(ok('  uid=jdoe  '))).toBe('(uid=jdoe)')
    expect(serialize(ok('\n(cn=x)\n'))).toBe('(cn=x)')
  })

  it('accepts whitespace between components', () => {
    expect(serialize(ok('(&\n  (cn=a)\n  (| (uid=b) (uid=c) )\n)'))).toBe(
      '(&(cn=a)(|(uid=b)(uid=c)))',
    )
    expect(serialize(ok('(! (cn=a) )'))).toBe('(!(cn=a))')
  })

  it.each([
    ['', 'empty filter', 0],
    ['   ', 'empty filter', 0],
    ['(cn=x', 'unclosed (', 0],
    ['(&(cn=a)', 'unclosed (', 0],
    ['(cn=a(b)', 'unescaped ( in value', 5],
    ['(cn~=a*)', '* is only allowed with =', 6],
    ['(=x)', 'missing attribute name', 1],
    ['(c n=x)', 'invalid attribute "c n"', 1],
    ['(cn=\\zz)', 'invalid escape', 4],
    ['(cn=\\2)', 'invalid escape', 4],
    ['(cnx)', 'expected attribute=value', 1],
    ['(&(cn=a)x)', 'expected )', 8],
    ['(cn=a))', 'unexpected text after filter', 6],
    ['(:dn:=x)', 'invalid attribute ":dn"', 1],
    ['cn=a)b', 'unescaped ) in value', 4],
  ])('rejects %j', (text, message, from) => {
    const r = parse(text)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.message).toContain(message)
      expect(r.error.from).toBe(from)
      expect(r.error.to).toBeGreaterThanOrEqual(r.error.from)
      expect(r.error.to).toBeLessThanOrEqual(text.length)
    }
  })

  it('rejects nesting deeper than the server allows instead of overflowing the stack', () => {
    const deep = (levels: number) => '(!'.repeat(levels - 1) + '(cn=x)' + ')'.repeat(levels - 1)
    expect(parse(deep(64)).ok).toBe(true)
    expect(parse(deep(65))).toEqual({
      ok: false,
      error: { from: 128, to: 129, message: 'filter nests deeper than 64 levels' },
    })
    expect(parse('(&'.repeat(8192)).ok).toBe(false)
  })
})

describe('format', () => {
  it('keeps short filters on one line', () => {
    expect(format(ok('(&(cn=a)(uid=b))'))).toBe('(&(cn=a)(uid=b))')
  })

  it('indents long filters and re-parses to the same AST', () => {
    const f = ok(canonical[canonical.length - 1])
    const pretty = format(f)
    expect(pretty).toBe(
      [
        '(&',
        '  (objectCategory=person)',
        '  (objectClass=user)',
        '  (!(userAccountControl:1.2.840.113556.1.4.803:=2))',
        ')',
      ].join('\n'),
    )
    expect(ok(pretty)).toEqual(f)
  })

  it.each(canonical)('format(%s) re-parses losslessly', (text) => {
    expect(ok(format(ok(text)))).toEqual(ok(text))
  })
})

describe('escapeValue', () => {
  it('escapes the RFC 4515 specials only', () => {
    expect(escapeValue('a*b(c)d\\e\0f Jürgen')).toBe('a\\2ab\\28c\\29d\\5ce\\00f Jürgen')
  })
})

describe('builder groups', () => {
  it('wraps a single item and unwraps it again', () => {
    const item: Filter = { type: 'cmp', attr: 'cn', op: '=', value: 'a' }
    expect(toGroup(item)).toEqual({ type: 'and', children: [item] })
    expect(fromGroup(toGroup(item))).toEqual(item)
    const or: Filter = { type: 'or', children: [item] }
    expect(toGroup(or)).toBe(or)
    expect(fromGroup({ type: 'or', children: [item] })).toEqual(or)
  })
})

describe('nameFilter', () => {
  it('escapes the query', () => {
    expect(nameFilter(' j*(doe) ')).toBe(
      '(|(cn=*j\\2a\\28doe\\29*)(uid=j\\2a\\28doe\\29*)(sAMAccountName=j\\2a\\28doe\\29*)(mail=j\\2a\\28doe\\29*)(displayName=*j\\2a\\28doe\\29*))',
    )
    expect(parse(nameFilter('x)(objectClass=*')).ok).toBe(true)
  })
})

describe('completeFilter', () => {
  const attrs = ['cn', 'cNAMERecord', 'mail', 'objectClass', 'uid', 'uidNumber']
  const classes = ['inetOrgPerson', 'organizationalUnit', 'person']

  it('offers attribute names after (', () => {
    expect(completeFilter('(&(ui', attrs, classes)).toEqual({
      from: 3,
      options: [{ label: 'uid' }, { label: 'uidNumber' }],
    })
    expect(completeFilter('(', attrs, classes)?.options).toHaveLength(attrs.length)
  })

  it('offers operators after a complete attribute name', () => {
    const r = completeFilter('(&(uid', attrs, classes)
    expect(r?.from).toBe(6)
    expect(r?.options.map((o) => o.label)).toEqual(['=', '=*', '>=', '<=', '~='])
  })

  it('offers objectClass values', () => {
    expect(completeFilter('(objectClass=per', attrs, classes)).toEqual({
      from: 13,
      options: [{ label: 'person' }],
    })
  })

  it('returns null elsewhere', () => {
    expect(completeFilter('(cn=jo', attrs, classes)).toBeNull()
    expect(completeFilter('(&', attrs, classes)).toBeNull()
    expect(completeFilter('(cn=a)', attrs, classes)).toBeNull()
  })
})
