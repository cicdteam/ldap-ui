import type { ReactNode } from 'react'

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border px-1 font-mono text-[11px] leading-4 text-muted">
      {children}
    </kbd>
  )
}
