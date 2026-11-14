import type { ReactNode } from 'react'
import { errorMessage, isApiError } from '../lib/api'
import { cn } from './cn'

const tones = {
  info: 'border-accent',
  warn: 'border-warn',
  danger: 'border-danger',
}

export function Banner({
  tone,
  children,
  action,
  detail,
}: {
  tone: keyof typeof tones
  children: ReactNode
  action?: ReactNode
  detail?: string
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('border-l-2 bg-panel px-3 py-2', tones[tone])}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">{children}</div>
        {action}
      </div>
      {detail && (
        <details className="mt-1 text-muted">
          <summary className="cursor-pointer text-xs">Server diagnostic</summary>
          <pre className="mt-1 font-mono text-xs break-all whitespace-pre-wrap">{detail}</pre>
        </details>
      )}
    </div>
  )
}

/** An API or unexpected error, with the raw server diagnostic behind a disclosure. */
export function ErrorBanner({ error, action }: { error: unknown; action?: ReactNode }) {
  const detail = isApiError(error) ? error.body.diagnostic : undefined
  return (
    <Banner tone="danger" action={action} detail={detail}>
      {errorMessage(error)}
    </Banner>
  )
}
