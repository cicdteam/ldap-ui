// DN helpers per RFC 4514. Comparison lowercases each RDN's type and unescaped
// value, so "\2C" (OpenLDAP) and "\," (users, AD) match; that is right for the
// case-insensitive attributes DNs use in practice. It does not apply full
// schema-aware normalization (OID vs name types, multi-valued RDN order).

/** Removes unescaped spaces around an RDN ("cn=a , dc=x" from sloppy input). */
function trimRDN(s: string): string {
  let r = s.trimStart()
  while (r.endsWith(' ') && !r.endsWith('\\ ')) r = r.slice(0, -1)
  return r
}

/** Splits on unescaped sep: a DN into RDNs, or with "+" an RDN into its pairs. */
export function splitDN(dn: string, sep = ','): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < dn.length; i++) {
    const ch = dn[i]
    if (ch === '\\' && i + 1 < dn.length) {
      cur += ch + dn[i + 1]
      i++
    } else if (ch === sep) {
      out.push(trimRDN(cur))
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(trimRDN(cur))
  return out.filter((r) => r !== '')
}

export function joinDN(rdns: string[]): string {
  return rdns.join(',')
}

export function parentDN(dn: string): string {
  return joinDN(splitDN(dn).slice(1))
}

/** Decodes "\," style and "\C3\BC" hex escapes (UTF-8 bytes). */
export function unescapeDNValue(v: string): string {
  // Fast path: most values have no escapes, and normDN runs per tree row per render.
  if (!v.includes('\\')) return v
  const enc = new TextEncoder()
  const chars = Array.from(v)
  const bytes: number[] = []
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (ch === '\\') {
      const hex = (chars[i + 1] ?? '') + (chars[i + 2] ?? '')
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16))
        i += 2
        continue
      }
      if (i + 1 < chars.length) {
        i++
        bytes.push(...enc.encode(chars[i]))
        continue
      }
    }
    bytes.push(...enc.encode(ch))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function firstUnescaped(s: string, target: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === target) return i
  }
  return -1
}

export function rdnType(rdn: string): string {
  const i = firstUnescaped(rdn, '=')
  return i < 0 ? '' : rdn.slice(0, i)
}

export function rdnValue(rdn: string): string {
  const i = firstUnescaped(rdn, '=')
  return unescapeDNValue(i < 0 ? rdn : rdn.slice(i + 1))
}

/** "cn=Doe, John" for "cn=Doe\, John": readable, not for sending back. */
export function rdnDisplay(rdn: string): string {
  const t = rdnType(rdn)
  return t ? `${t}=${rdnValue(rdn)}` : rdnValue(rdn)
}

/** Comparison key; "\" and "," are re-escaped so keys join without ambiguity. */
function normRDN(rdn: string): string {
  const v = rdnValue(rdn).toLowerCase().replace(/[\\,]/g, '\\$&')
  return `${rdnType(rdn).toLowerCase()}=${v}`
}

/** A comparison key for dn, not a DN to send back to the server. */
export function normDN(dn: string): string {
  return splitDN(dn).map(normRDN).join(',')
}

export function sameDN(a: string, b: string): boolean {
  return normDN(a) === normDN(b)
}

/** True when dn equals base or lies below it. */
export function isUnder(dn: string, base: string): boolean {
  const d = splitDN(dn).map(normRDN)
  const b = splitDN(base).map(normRDN)
  if (b.length === 0 || b.length > d.length) return false
  const off = d.length - b.length
  return b.every((r, i) => r === d[off + i])
}

export interface Crumb {
  label: string
  dn: string
}

export function breadcrumbs(dn: string, base: string): Crumb[] {
  const rdns = splitDN(dn)
  const baseLen = isUnder(dn, base) ? splitDN(base).length : 0
  const crumbs: Crumb[] = []
  if (baseLen > 0) {
    const b = joinDN(rdns.slice(rdns.length - baseLen))
    crumbs.push({ label: b, dn: b })
  }
  for (let i = rdns.length - baseLen - 1; i >= 0; i--) {
    crumbs.push({ label: rdnDisplay(rdns[i]), dn: joinDN(rdns.slice(i)) })
  }
  return crumbs
}

/** DNs from root down to the parent of dn, when dn lies strictly below root. */
export function ancestorsWithin(dn: string, root: string): string[] {
  if (!isUnder(dn, root)) return []
  const rdns = splitDN(dn)
  const rootLen = splitDN(root).length
  const out: string[] = []
  for (let i = rdns.length - rootLen; i >= 1; i--) out.push(joinDN(rdns.slice(i)))
  return out
}

export function looksLikeDN(s: string): boolean {
  return /^\s*([A-Za-z][A-Za-z0-9-]*|\d+(\.\d+)+)\s*=[^=]/.test(s)
}
