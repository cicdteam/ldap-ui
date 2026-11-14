import type { ComponentProps } from 'react'
import { cn } from './cn'

export function Input({ className, mono, ...rest }: ComponentProps<'input'> & { mono?: boolean }) {
  return (
    <input
      className={cn(
        'h-[var(--ctl)] min-w-0 rounded-md border border-border-strong bg-bg px-2 text-fg outline-none placeholder:text-muted focus:border-accent focus:ring-3 focus:ring-accent/30',
        mono && 'font-mono text-xs',
        className,
      )}
      {...rest}
    />
  )
}
