import { Lock, Plus } from 'lucide-react'
import { useState } from 'react'
import { batches } from '../../lib/batchStore'
import { isBinaryAttr } from '../../lib/binary'
import {
  dropStale,
  entryChanges,
  missingMust,
  validate,
  view,
  type Edit,
  type MarkedValue,
} from '../../lib/changes'
import { shownValues, valueMatches } from '../../lib/display'
import { auxiliaryCandidates, classLock, editorKind, lockReason } from '../../lib/edit'
import { bannerShown, errorText, fieldMessage } from '../../lib/review'
import {
  attributeHelp,
  attrKey,
  baseName,
  groupAttributes,
  type SchemaIndex,
} from '../../lib/schema'
import type { ApiErrorBody, Attribute, Entry } from '../../lib/types'
import { Banner } from '../../ui/Banner'
import { Button } from '../../ui/Button'
import { Input, inputLook } from '../../ui/Input'
import { useBatch, useBatchError } from '../batch'
import { useWorkspace } from '../context'
import { AddAttribute } from './AddAttribute'
import { EditValue, UploadFile, ValueView } from './Value'
import { keepFocusIn, ValueEditor } from './ValueEditor'

// A group with tens of thousands of members would freeze the tab: rows list
// FIRST_VALUES and grow by MORE_VALUES on request.
const FIRST_VALUES = 100
const MORE_VALUES = 1000

interface RowProps {
  /** The entry's DN: edits are staged for it. */
  dn: string
  editing: boolean
  needle: string
  schema: SchemaIndex
  /** Validation problems of the staged changes, keyed by attrKey. */
  problems: Map<string, string>
  /** The entry's stored apply error: shown on the row it names. */
  error: ApiErrorBody | undefined
  /** The entry banner announces the error: the row then shows it without role=alert. */
  banner: boolean
}

function AttributeRow({
  attr,
  dn,
  editing,
  needle,
  schema,
  problems,
  error,
  banner,
}: RowProps & { attr: Attribute }) {
  const ws = useWorkspace()
  // Raised under one needle; a new needle starts again from FIRST_VALUES.
  const [more, setMore] = useState({ needle, limit: FIRST_VALUES })
  const [adding, setAdding] = useState(false)
  // Why the last chosen file was not staged (too large, empty).
  const [fileError, setFileError] = useState('')
  const limit = more.needle === needle ? more.limit : FIRST_VALUES
  const { shown, total } = shownValues(attr, needle, limit)
  const lock = editing ? lockReason(attr.name, schema) : ''
  const edit = editing && !lock
  const stage = (e: Edit) => {
    batches.stage(ws.conn, dn, e)
    keepFocusIn(attr.name)
  }
  const kept = (attr.values ?? []).some((v) => (v as MarkedValue).mark !== 'deleted')
  const full = kept && !!schema.attr(attr.name)?.singleValue
  const binary = isBinaryAttr(attr.name, schema, attr.values)
  // A file error is about an upload, which only Edit shows.
  const problem = (edit && fileError) || fieldMessage(attr.name, problems, error)
  const oc = baseName(attr.name) === 'objectclass'
  const classes = (attr.values ?? [])
    .filter((v) => (v as MarkedValue).mark !== 'deleted')
    .map((v) => v.text)
  return (
    <div
      data-attr={attr.name}
      role="group"
      aria-label={attr.name}
      tabIndex={-1}
      className="grid grid-cols-[minmax(7rem,11rem)_1fr] gap-2 border-b border-border/50 px-2 py-[var(--pad)]"
    >
      <div
        className="truncate font-mono text-xs font-semibold"
        title={attributeHelp(attr.name, schema)}
      >
        {attr.name}
      </div>
      <ul className="min-w-0" title={lock || undefined}>
        {attr.masked ? (
          <li className="flex items-center gap-1 py-0.5 text-xs text-muted">
            <Lock className="h-3 w-3" /> hidden ({attr.masked}{' '}
            {attr.masked === 1 ? 'value' : 'values'})
          </li>
        ) : null}
        {shown.map(({ value, index }) =>
          // Keyed by text too: an editor's draft belongs to one value.
          edit ? (
            <EditValue
              key={`${index}:${value.text}`}
              attr={attr.name}
              dn={dn}
              index={index}
              value={value}
              schema={schema}
              stage={stage}
              fixed={oc ? classLock(value.text, schema) : undefined}
            />
          ) : (
            <ValueView
              key={`${index}:${value.text}`}
              attr={attr.name}
              dn={dn}
              index={index}
              value={value}
              schema={schema}
            />
          ),
        )}
        {total > shown.length && (
          <li>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMore({ needle, limit: limit + MORE_VALUES })}
            >
              Show {Math.min(MORE_VALUES, total - shown.length)} more ({total} total)
            </Button>
          </li>
        )}
        {edit && adding && (
          <li className="flex py-0.5">
            <ValueEditor
              attr={attr.name}
              value=""
              kind={editorKind(attr.name, '', schema)}
              autoFocus
              onCommit={(t) => {
                stage({ kind: 'add', attr: attr.name, value: t })
                setAdding(false)
              }}
              onCancel={() => setAdding(false)}
            />
          </li>
        )}
        {edit && oc && (
          <li>
            <select
              aria-label="Add object class"
              value=""
              onChange={(e) => {
                if (e.target.value) stage({ kind: 'add', attr: attr.name, value: e.target.value })
              }}
              className={`h-7 px-2 text-xs ${inputLook}`}
            >
              <option value="">+ class</option>
              {auxiliaryCandidates(classes, schema).map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </li>
        )}
        {edit && !oc && !adding && !full && binary && (
          <li>
            <UploadFile
              attr={attr.name}
              onFile={(b64) => {
                setFileError('')
                stage({ kind: 'add', attr: attr.name, value: b64, base64: true })
              }}
              onError={setFileError}
            />
          </li>
        )}
        {edit && !oc && !adding && !full && !binary && (
          <li>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Add ${attr.name} value`}
              data-add-value
              onClick={() => setAdding(true)}
            >
              <Plus className="h-3.5 w-3.5" /> value
            </Button>
          </li>
        )}
      </ul>
      {problem && (
        <p
          role={
            (edit && fileError) || !banner || problems.has(attrKey(attr.name)) ? 'alert' : undefined
          }
          className="col-start-2 text-xs text-danger"
        >
          {problem}
        </p>
      )}
    </div>
  )
}

function Section({
  title,
  attrs,
  open,
  ...row
}: RowProps & { title: string; attrs: Attribute[]; open: boolean }) {
  if (attrs.length === 0) return null
  return (
    <details open={open} className="border-b border-border">
      <summary className="cursor-pointer bg-panel px-2 py-1 text-[11px] font-semibold tracking-[.04em] text-muted uppercase">
        {title} <span className="font-normal">({attrs.length})</span>
      </summary>
      {attrs.map((a) => (
        <AttributeRow key={a.name} attr={a} {...row} />
      ))}
    </details>
  )
}

/** The entry with its staged changes; editing turns values into editors. */
export function Attributes({
  entry,
  editing,
  reload,
}: {
  entry: Entry
  editing: boolean
  /** Refetches the entry. */
  reload: () => void
}) {
  const ws = useWorkspace()
  const batch = useBatch(ws.conn)
  const error = useBatchError(ws.conn, entry.dn)
  // dropStale keeps the batch identity when no staged edit is stale.
  const stale = dropStale(batch, entry) !== batch
  const ec = entryChanges(batch, entry.dn)
  const viewed = view(entry, ec)
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const matches = (a: Attribute) =>
    !needle ||
    a.name.toLowerCase().includes(needle) ||
    (a.values ?? []).some((v) => valueMatches(v, needle))
  // Group before filtering: grouping reads the objectClass attribute, which a filter may drop.
  // A class staged for add brings its missing MUST attributes as empty rows to fill.
  const rows = [
    ...(viewed.attributes ?? []),
    ...missingMust(entry, ec, ws.schema).map((name) => ({ name, values: [] })),
  ]
  const g = groupAttributes(rows, ws.schema)
  const problems = validate(entry, ec, ws.schema)
  const must = g.must.filter(matches)
  const may = g.may.filter(matches)
  const operational = g.operational.filter(matches)
  // OPERATIONAL is closed unless a filter is typed or a row there has a problem to fix.
  const opOpen = !!needle || operational.some((a) => problems.has(attrKey(a.name)))
  const shown = [...must, ...may, ...(opOpen ? operational : [])].map((a) => a.name)
  const banner = !!error && bannerShown(error, shown, problems)
  const row = { dn: entry.dn, editing, needle, schema: ws.schema, problems, error, banner }
  return (
    <div>
      {/* Stays until the next apply: Reload entry turns the conflict into stale marks to drop. */}
      {error && banner && (
        <Banner
          tone="danger"
          detail={error.diagnostic}
          action={
            error.code === 'conflict' && (
              <>
                <Button size="sm" onClick={reload}>
                  Reload entry
                </Button>
                <Button
                  size="sm"
                  disabled={!stale}
                  onClick={() => batches.set(ws.conn, dropStale(batches.get(ws.conn), entry))}
                >
                  Drop stale changes
                </Button>
              </>
            )
          }
        >
          {errorText(error)}
        </Banner>
      )}
      <div className="p-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter attributes and values"
          aria-label="Filter attributes and values"
          className="w-full"
        />
      </div>
      {!ws.schema.available && (
        <p className="px-2 pb-2 text-xs text-warn">No schema: attributes are not grouped.</p>
      )}
      <Section title="REQUIRED (MUST)" attrs={must} open {...row} />
      <Section
        title={ws.schema.available ? 'OPTIONAL (MAY)' : 'ATTRIBUTES'}
        attrs={may}
        open
        {...row}
      />
      <Section title="OPERATIONAL" attrs={operational} open={opOpen} {...row} />
      {must.length + may.length + operational.length === 0 && (
        <p className="p-2 text-muted">No attributes match.</p>
      )}
      {/* The missing MUST rows are there to fill, so the picker does not offer them again. */}
      {editing && <AddAttribute entry={{ ...viewed, attributes: rows }} />}
    </div>
  )
}
