import type { Info, Profile } from './types'

export type StatusTone = 'ok' | 'warn' | 'danger'

/** The status bar's text: never color alone, every tone has its words. */
export interface ConnectionStatus {
  address?: string
  transport: { text: string; tone: StatusTone }
  server: string
  changes: string
}

/** changes: the staged count the Review badge shows. profile: undefined until the list loads. */
export function connectionStatus(
  info: Pick<Info, 'encrypted' | 'insecureSkipVerify' | 'activeDirectory' | 'vendor'>,
  profile: Pick<Profile, 'url' | 'startTLS'> | undefined,
  changes: number,
): ConnectionStatus {
  const tls = profile?.startTLS ? 'StartTLS' : 'TLS'
  const transport: ConnectionStatus['transport'] = !info.encrypted
    ? { text: 'not encrypted', tone: 'warn' }
    : info.insecureSkipVerify
      ? { text: `${tls}, certificate not verified`, tone: 'danger' }
      : { text: tls, tone: 'ok' }
  return {
    address: profile?.url,
    transport,
    server: info.activeDirectory ? 'Active Directory' : info.vendor || 'LDAP',
    changes:
      changes === 0 ? 'no staged changes' : `${changes} ${changes === 1 ? 'change' : 'changes'}`,
  }
}
