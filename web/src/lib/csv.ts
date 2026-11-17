import type { Entry } from './types'

/** Human-readable cell text: decoded display values joined with "; ". */
export function cellValue(e: Entry, column: string): string {
  const col = column.toLowerCase()
  if (col === 'dn') return e.dn
  const a = (e.attributes ?? []).find((x) => x.name.toLowerCase() === col)
  if (!a) return ''
  if (a.masked) return '(hidden)'
  return (a.values ?? []).map((v) => v.display ?? v.text).join('; ')
}

/**
 * Quotes per RFC 4180 and defuses spreadsheet formulas (OWASP CSV injection): at the start and
 * after every separator a spreadsheet may split the cell on, since values join with "; ".
 */
export function csvField(s: string): string {
  const v = (/^[\t\r]/.test(s) ? `'${s}` : s).replace(/(^|[;,\t\r\n])(\s*)([=+\-@])/g, "$1$2'$3")
  return /[",\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v
}

export function toCSV(entries: Entry[], columns: string[]): string {
  const cols = ['dn', ...columns.filter((c) => c.toLowerCase() !== 'dn')]
  const rows = [cols, ...entries.map((e) => cols.map((c) => cellValue(e, c)))]
  return rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n'
}
