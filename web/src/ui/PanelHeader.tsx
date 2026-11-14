import type { ReactNode } from 'react'

/** The caption strip at the top of a workspace panel (DIRECTORY, SEARCH, ENTRY). */
export function PanelHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center border-b border-border px-2 text-[11px] font-semibold tracking-wide text-muted">
      {children}
    </div>
  )
}
