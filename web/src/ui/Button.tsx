import type { ComponentProps } from 'react'
import { cn } from './cn'
import { useTip } from './Tip'

type Variant = 'primary' | 'default' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'icon'

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90',
  default: 'border border-border bg-bg hover:bg-hover',
  ghost: 'text-muted hover:bg-hover hover:text-fg',
  danger: 'bg-danger text-white hover:opacity-90',
}
const sizes: Record<Size, string> = {
  sm: 'h-7 gap-1 px-2 text-xs',
  md: 'h-[var(--ctl)] gap-1.5 px-3',
  // Icon buttons follow the density, so they never make a row taller than --row.
  icon: 'h-[var(--row)] w-[var(--row)] justify-center',
}

/**
 * title shows as a quick tooltip (useTip), not the browser's slow one. An icon button without an
 * aria-label is named by its title; any other button gets it as its description.
 */
export function Button({
  variant = 'default',
  size = 'md',
  className,
  type = 'button',
  title,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onFocus,
  onBlur,
  ...rest
}: ComponentProps<'button'> & { variant?: Variant; size?: Size }) {
  const tip = useTip(title)
  const both =
    <E,>(a: ((e: E) => void) | undefined, b: (e: E) => void) =>
    (e: E) => {
      a?.(e)
      b(e)
    }
  return (
    <>
      <button
        type={type}
        className={cn(
          'inline-flex shrink-0 items-center rounded-md font-medium whitespace-nowrap disabled:pointer-events-none disabled:opacity-50',
          variants[variant],
          sizes[size],
          className,
        )}
        aria-label={size === 'icon' && !rest['aria-label'] ? title : undefined}
        aria-describedby={tip.describedBy}
        onPointerEnter={both(onPointerEnter, tip.on.onPointerEnter)}
        onPointerLeave={both(onPointerLeave, tip.on.onPointerLeave)}
        onPointerDown={both(onPointerDown, tip.on.onPointerDown)}
        onFocus={both(onFocus, tip.on.onFocus)}
        onBlur={both(onBlur, tip.on.onBlur)}
        {...rest}
      />
      {tip.node}
    </>
  )
}
