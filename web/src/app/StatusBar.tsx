import { touchedAttributes } from '../lib/changes'
import { connectionStatus, type StatusTone } from '../lib/status'
import { useBatch } from './batch'
import { useWorkspace } from './context'

const tones: Record<StatusTone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
}

/** The connection at a glance: address, transport, server type and staged changes. */
export function StatusBar() {
  const ws = useWorkspace()
  const s = connectionStatus(ws.info, touchedAttributes(useBatch(ws.conn)))
  return (
    <footer
      aria-label="Connection status"
      className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-chrome px-2 font-mono text-[11px] whitespace-nowrap text-muted [[data-density='compact']_&]:h-[22px]"
    >
      <span className="min-w-0 truncate">{s.address}</span>
      <span className={tones[s.transport.tone]}>{s.transport.text}</span>
      <span>{s.server}</span>
      <span className="ml-auto">{s.changes}</span>
    </footer>
  )
}
