import { Info } from 'lucide-react'
import { useServer } from './queries'

/**
 * The operator's --notice, a strip above every page. Plain text, never markup; a newline in it
 * breaks the line, and a long one wraps rather than being cut off.
 */
export function Notice() {
  const notice = useServer().data?.notice
  if (!notice) return null
  return (
    <div
      role="note"
      aria-label="Notice"
      className="flex shrink-0 items-start gap-2 border-b border-accent/20 bg-selected px-3 py-[5px] text-[12.5px] leading-[1.4]"
    >
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-text" />
      <p className="min-w-0 wrap-anywhere whitespace-pre-line">{notice}</p>
    </div>
  )
}
