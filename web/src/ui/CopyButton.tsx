import { Check, Copy } from 'lucide-react'
import { useEffect, useState, type ComponentProps, type ReactNode } from 'react'
import { Button } from './Button'

/**
 * title, when given, explains what is copied; the label stays the accessible name. An icon button
 * by default; children add visible text after the icon.
 */
export function CopyButton({
  text,
  label = 'Copy',
  title = label,
  children,
  ...look
}: {
  text: string
  label?: string
  title?: string
  children?: ReactNode
} & Pick<ComponentProps<typeof Button>, 'size' | 'variant' | 'className'>) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <Button
      size="icon"
      variant="ghost"
      {...look}
      aria-label={label}
      title={title}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true))
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
      {children}
    </Button>
  )
}
