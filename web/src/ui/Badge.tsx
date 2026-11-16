import type { ReactNode } from 'react'
import { profileBadges, safeColor, type Tone } from '../lib/display'
import type { Profile } from '../lib/types'
import { cn } from './cn'

const tones: Record<Tone, string> = {
  neutral: 'border-border bg-panel text-muted',
  danger: 'border-danger/40 bg-danger/10 text-danger',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  ok: 'border-ok/40 bg-ok/10 text-ok',
  accent: 'border-accent/40 bg-accent/10 text-accent-text',
}

const shapes = {
  pill: 'rounded-full px-2 text-[11px] font-semibold tracking-wide',
  chip: 'rounded px-1.5 font-mono text-[10.5px]',
}

/** A label: pill by default; chip for value-like tokens (objectClasses, UAC flags). */
export function Badge({
  tone = 'neutral',
  shape = 'pill',
  children,
}: {
  tone?: Tone
  shape?: keyof typeof shapes
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center border whitespace-nowrap',
        shapes[shape],
        tones[tone],
      )}
    >
      {children}
    </span>
  )
}

/** The profile's color from config, only when it is a safe CSS color. */
export function ColorDot({ color }: { color?: string }) {
  const c = safeColor(color)
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-border"
      style={c ? { background: c } : undefined}
    />
  )
}

/** Read-only and insecure-TLS labels: text, never color alone. */
export function ProfileBadges({
  profile,
}: {
  profile: Pick<Profile, 'readOnly' | 'insecureSkipVerify'>
}) {
  return (
    <>
      {profileBadges(profile).map((b) => (
        <Badge key={b.label} tone={b.tone}>
          {b.label}
        </Badge>
      ))}
    </>
  )
}

/** Marks a tree or result row whose entry has staged changes. */
export function ChangeDot() {
  return (
    <span
      role="img"
      aria-label="Has unapplied changes"
      title="Has unapplied changes"
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warn"
    />
  )
}
