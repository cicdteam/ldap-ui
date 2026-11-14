import * as D from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'
import { cn } from './cn'

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  wide,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  wide?: boolean
  children: ReactNode
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <D.Content
          // The trap holds focus only on what it focused itself (React's autoFocus comes too early
          // and loses focus to a closing menu's trigger), so it focuses [data-autofocus] here.
          onOpenAutoFocus={(e) => {
            const el = (e.target as HTMLElement).querySelector<HTMLElement>('[data-autofocus]')
            if (!el) return
            e.preventDefault()
            el.focus()
          }}
          className={cn(
            'fixed top-[10vh] z-40 left-1/2 max-h-[80vh] -translate-x-1/2 elevated overflow-auto rounded-[10px] border border-border bg-bg p-4 text-fg',
            wide ? 'w-[min(92vw,44rem)]' : 'w-[min(92vw,28rem)]',
          )}
        >
          <D.Title className="mb-3 text-sm font-semibold">{title}</D.Title>
          <D.Description className={description ? 'mb-3 text-muted' : 'sr-only'}>
            {description ?? title}
          </D.Description>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
