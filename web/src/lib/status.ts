import type { Info } from './types'

export type StatusTone = 'ok' | 'warn' | 'danger'

/** The status bar's text: never color alone, every tone has its words. */
export interface ConnectionStatus {
  address: string
  transport: { text: string; tone: StatusTone }
  server: string
}

/** "1 change", "2 changes": n and the noun for it. */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "2 changes in 1 entry": a staged batch's size. */
export function changesIn(changes: number, entries: number): string {
  return `${plural(changes, 'change', 'changes')} in ${plural(entries, 'entry', 'entries')}`
}

/** The pending-changes bar: "2 changes in 1 entry staged for demo". */
export function pendingText(changes: number, entries: number, profile: string): string {
  return `${changesIn(changes, entries)} staged for ${profile}`
}

export function connectionStatus(
  info: Pick<
    Info,
    'url' | 'startTLS' | 'encrypted' | 'insecureSkipVerify' | 'activeDirectory' | 'vendor'
  >,
): ConnectionStatus {
  const tls = info.startTLS ? 'StartTLS' : 'TLS'
  const transport: ConnectionStatus['transport'] = !info.encrypted
    ? { text: 'not encrypted', tone: 'warn' }
    : info.insecureSkipVerify
      ? { text: `${tls}, certificate not verified`, tone: 'danger' }
      : { text: tls, tone: 'ok' }
  return {
    address: info.url,
    transport,
    server: info.activeDirectory ? 'Active Directory' : info.vendor?.trim() || 'LDAP',
  }
}
