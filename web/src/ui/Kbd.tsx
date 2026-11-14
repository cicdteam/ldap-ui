import type { ReactNode } from 'react'

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-b-2 border-border-strong bg-panel px-1 font-mono text-[11px] leading-4 text-muted">
      {children}
    </kbd>
  )
}
