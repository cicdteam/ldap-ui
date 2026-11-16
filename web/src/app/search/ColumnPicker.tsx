import { X } from 'lucide-react'
import { useId, useState } from 'react'
import { parseColumns } from '../../lib/nav'
import { Input } from '../../ui/Input'
import { useWorkspace } from '../context'

/** The result columns after Name: chips to remove, a field that adds a schema attribute name. */
export function ColumnPicker({
  columns,
  onChange,
}: {
  columns: string[]
  onChange: (columns: string[]) => void
}) {
  const ws = useWorkspace()
  const [column, setColumn] = useState('')
  const names = useId()
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {columns.map((c) => (
        <span
          key={c}
          className="flex items-center rounded-md border border-border bg-panel pl-1.5 font-mono text-xs"
        >
          {c}
          <button
            type="button"
            aria-label={`Remove column ${c}`}
            className="rounded px-1 text-muted hover:text-fg"
            onClick={() => onChange(columns.filter((x) => x !== c))}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <form
        className="min-w-32 flex-1"
        onSubmit={(e) => {
          e.preventDefault()
          // An empty field or a column already shown changes nothing.
          const next = parseColumns([...columns, column].join(','))
          if (next.length !== columns.length) onChange(next)
          setColumn('')
        }}
      >
        <Input
          mono
          list={names}
          aria-label="Add a column"
          placeholder="Add a column"
          title="An attribute name from the schema; Enter adds it"
          value={column}
          onChange={(e) => setColumn(e.target.value)}
          className="w-full"
        />
        <datalist id={names}>
          {ws.schema.attrNames.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </form>
    </div>
  )
}
