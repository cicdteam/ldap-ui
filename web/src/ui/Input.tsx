import type { ComponentProps } from 'react'
import { cn } from './cn'

/** The input look (surface, border, focus ring) for the selects and textareas Input does not render. */
export const inputLook =
  'rounded-md border border-border-strong bg-bg text-fg outline-none placeholder:text-muted focus:border-accent focus:ring-3 focus:ring-accent/30'

export function Input({ className, mono, ...rest }: ComponentProps<'input'> & { mono?: boolean }) {
  return (
    <input
      className={cn(
        'h-[var(--ctl)] min-w-0 px-2',
        inputLook,
        mono && 'font-mono text-xs',
        className,
      )}
      {...rest}
    />
  )
}
