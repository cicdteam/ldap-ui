import type { ReactNode } from 'react'
import { envBadges, safeColor, type Tone } from '../lib/display'
import type { Profile } from '../lib/types'
import { cn } from './cn'

const tones: Record<Tone, string> = {
  neutral: 'border-border text-muted',
  danger: 'border-danger text-danger',
  warn: 'border-warn text-warn',
  ok: 'border-ok text-ok',
  accent: 'border-accent text-accent-text',
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded border px-1.5 text-[11px] font-semibold tracking-wide whitespace-nowrap',
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

/** Environment, read-only and insecure-TLS labels: text, never color alone. */
export function ProfileBadges({
  profile,
}: {
  profile: Pick<Profile, 'environment' | 'readOnly' | 'insecureSkipVerify'>
}) {
  return (
    <>
      {envBadges(profile).map((b) => (
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
