import type { Attribute, Profile, Value } from './types'

/** Accepts #rgb(a)/#rrggbb(aa) or a bare color keyword; anything else is dropped. */
export function safeColor(c?: string): string | undefined {
  if (!c) return undefined
  return /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c) || /^[a-z]{3,20}$/i.test(c)
    ? c
    : undefined
}

export type Tone = 'neutral' | 'danger' | 'warn' | 'ok' | 'accent'

export function envBadges(
  p: Pick<Profile, 'environment' | 'readOnly' | 'insecureSkipVerify'>,
): { label: string; tone: Tone }[] {
  const tone: Tone =
    p.environment === 'prod' ? 'danger' : p.environment === 'stage' ? 'warn' : 'neutral'
  const out: { label: string; tone: Tone }[] = [{ label: p.environment.toUpperCase(), tone }]
  if (p.readOnly) out.push({ label: 'READ-ONLY', tone: 'neutral' })
  if (p.insecureSkipVerify) out.push({ label: 'INSECURE TLS', tone: 'danger' })
  return out
}

/** Image MIME type sniffed from the base64 prefix, for data: URL previews. */
export function imageType(b64: string): 'image/jpeg' | 'image/png' | 'image/gif' | undefined {
  if (b64.startsWith('/9j/')) return 'image/jpeg'
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png'
  if (b64.startsWith('R0lGOD')) return 'image/gif'
  return undefined
}

export function byteLength(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - pad
}

/** The server's display text; RFC 3339 instants are shown in local time. */
export function formatDisplay(v: Value): string {
  const d = v.display
  if (d && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(d)) {
    const t = new Date(d)
    if (!Number.isNaN(t.getTime())) return t.toLocaleString()
  }
  return d ?? v.text
}

/** The attribute filter's rule for values; needle is lowercase. */
export function valueMatches(v: Value, needle: string): boolean {
  return (v.display ?? v.text).toLowerCase().includes(needle)
}

/**
 * The first limit values of attr to list under the attribute filter needle
 * (lowercase), each with its index in attr.values as a stable key, and how
 * many there are in all. A needle that is not in the name keeps only the
 * values that contain it.
 */
export function shownValues(
  attr: Attribute,
  needle: string,
  limit: number,
): { shown: { value: Value; index: number }[]; total: number } {
  let all = (attr.values ?? []).map((value, index) => ({ value, index }))
  if (needle && !attr.name.toLowerCase().includes(needle)) {
    all = all.filter(({ value }) => valueMatches(value, needle))
  }
  return { shown: all.slice(0, limit), total: all.length }
}
