import { Plus, X } from 'lucide-react'
import type { CmpOp, Filter, Group } from '../../lib/filter'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { Input, inputLook } from '../../ui/Input'

type Cmp = Extract<Filter, { type: 'cmp' }>
type OpChoice = CmpOp | 'present'

const OPS: { value: OpChoice; label: string }[] = [
  { value: '=', label: 'equals' },
  { value: 'present', label: 'is present' },
  { value: '>=', label: '>=' },
  { value: '<=', label: '<=' },
  { value: '~=', label: 'approx' },
  { value: ':=', label: 'extensible' },
]

const ATTR_LIST = 'ldapui-attr-names'

function CmpRow({ node, onChange }: { node: Cmp; onChange: (n: Cmp) => void }) {
  const present = node.op === '=' && node.value === '*'
  const op: OpChoice = present ? 'present' : node.op
  return (
    <>
      <Input
        mono
        list={ATTR_LIST}
        aria-label="Attribute"
        placeholder="attribute"
        value={node.attr}
        onChange={(e) => onChange({ ...node, attr: e.target.value.trim() })}
        className="flex-[1_1_8rem]"
      />
      <select
        aria-label="Operator"
        value={op}
        onChange={(e) => {
          const next = e.target.value as OpChoice
          if (next === 'present') onChange({ ...node, op: '=', value: '*' })
          else onChange({ ...node, op: next, value: present ? '' : node.value })
        }}
        className={`h-8 px-1 text-xs ${inputLook}`}
      >
        {OPS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {!present && (
        <Input
          mono
          aria-label="Value"
          placeholder="value, * is a wildcard"
          title="RFC 4515 value: * is a wildcard; write ( ) \ * literally as \28 \29 \5c \2a"
          value={node.value}
          onChange={(e) => onChange({ ...node, value: e.target.value })}
          className="flex-[2_1_8rem]"
        />
      )}
    </>
  )
}

function Child({
  node,
  onChange,
  onRemove,
  depth,
}: {
  node: Filter
  onChange: (n: Filter) => void
  onRemove: () => void
  depth: number
}) {
  const negated = node.type === 'not'
  const inner = negated ? node.child : node
  const set = (n: Filter) => onChange(negated ? { type: 'not', child: n } : n)
  return (
    <div className="flex items-start gap-1">
      <label className="flex h-8 items-center gap-1 text-[11px] text-muted" title="Negate">
        <input
          type="checkbox"
          checked={negated}
          onChange={() => onChange(negated ? inner : { type: 'not', child: inner })}
        />
        NOT
      </label>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {inner.type === 'cmp' ? (
          <CmpRow node={inner} onChange={set} />
        ) : inner.type === 'not' ? (
          <Child node={inner} onChange={set} onRemove={onRemove} depth={depth} />
        ) : (
          <GroupView group={inner} onChange={set} depth={depth + 1} />
        )}
      </div>
      <Button size="icon" variant="ghost" aria-label="Remove" title="Remove" onClick={onRemove}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

function GroupView({
  group,
  onChange,
  depth,
}: {
  group: Group
  onChange: (g: Group) => void
  depth: number
}) {
  const setChild = (i: number, n: Filter) =>
    onChange({ ...group, children: group.children.map((c, j) => (j === i ? n : c)) })
  const remove = (i: number) =>
    onChange({ ...group, children: group.children.filter((_, j) => j !== i) })
  const add = (n: Filter) => onChange({ ...group, children: [...group.children, n] })
  return (
    <div
      className={cn(
        'min-w-0 flex-1 space-y-1 rounded-md border border-border p-1.5',
        depth > 0 && 'bg-panel',
      )}
    >
      <div className="flex items-center gap-1">
        <div
          role="radiogroup"
          aria-label="Combine with"
          className="flex rounded border border-border text-[11px] font-semibold"
        >
          {(['and', 'or'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={group.type === t}
              onClick={() => onChange({ ...group, type: t })}
              className={cn(
                'px-2 py-0.5',
                group.type === t ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-hover',
              )}
            >
              {t === 'and' ? 'ALL of' : 'ANY of'}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => add({ type: 'cmp', attr: '', op: '=', value: '' })}
        >
          <Plus className="h-3 w-3" /> Condition
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => add({ type: group.type === 'and' ? 'or' : 'and', children: [] })}
        >
          <Plus className="h-3 w-3" /> Group
        </Button>
      </div>
      {group.children.map((c, i) => (
        <Child
          key={i}
          node={c}
          depth={depth}
          onChange={(n) => setChild(i, n)}
          onRemove={() => remove(i)}
        />
      ))}
    </div>
  )
}

export function FilterBuilder({
  group,
  onChange,
  attrNames,
}: {
  group: Group
  onChange: (g: Group) => void
  attrNames: string[]
}) {
  return (
    <div className="max-h-72 min-w-0 flex-1 overflow-auto">
      <datalist id={ATTR_LIST}>
        {attrNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <GroupView group={group} onChange={onChange} depth={0} />
    </div>
  )
}
