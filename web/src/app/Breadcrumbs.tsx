import { ChevronRight } from 'lucide-react'
import { breadcrumbs } from '../lib/dn'
import { cn } from '../ui/cn'

export function Breadcrumbs({
  dn,
  base,
  onSelect,
}: {
  dn: string
  base: string
  onSelect: (dn: string) => void
}) {
  const crumbs = breadcrumbs(dn, base)
  return (
    <nav aria-label="DN path" className="min-w-0 overflow-x-auto">
      <ol className="flex items-center gap-0.5 font-mono text-xs whitespace-nowrap">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <li key={c.dn} className="flex items-center gap-0.5">
              {i > 0 && <ChevronRight aria-hidden className="h-3 w-3 text-muted" />}
              <button
                type="button"
                aria-current={last ? 'page' : undefined}
                onClick={() => onSelect(c.dn)}
                className={cn(
                  'rounded px-1 hover:bg-hover',
                  last ? 'font-semibold text-fg' : 'text-muted',
                )}
              >
                {c.label}
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
