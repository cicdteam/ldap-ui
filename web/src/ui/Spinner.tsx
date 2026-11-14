import { LoaderCircle } from 'lucide-react'
import { cn } from './cn'

export function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      aria-label="Loading"
      className={cn('h-4 w-4 animate-spin text-muted', className)}
    />
  )
}
