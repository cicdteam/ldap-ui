import { ChevronDown, ChevronRight, Lock, Plus } from 'lucide-react'
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
import { pinnedAttributes, shownValues, valueMatches } from '../../lib/display'
import { auxiliaryCandidates, classLock, editorKind, lockReason } from '../../lib/edit'
import { bannerShown, errorText, fieldMessage, flagged } from '../../lib/review'
import {
  attributeHelp,
  attrKey,
  baseName,
  groupAttributes,
  type SchemaIndex,
} from '../../lib/schema'
import { entryKind } from '../../lib/tree'
import type { ApiErrorBody, Attribute, Entry } from '../../lib/types'
import { Banner } from '../../ui/Banner'
import { Button } from '../../ui/Button'
import { inputLook } from '../../ui/Input'
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
      // 30 px with one value (comfortable): --pad above, 1px less below, an 18px line, the border.
      className="grid grid-cols-[clamp(9rem,26%,12.5rem)_minmax(0,1fr)] gap-x-3 border-b border-border/50 pt-[var(--pad)] pr-4 pb-[calc(var(--pad)-1px)] pl-[30px] hover:bg-hover"
    >
      <div
        className="truncate font-mono text-xs leading-[18px] font-semibold"
        title={attributeHelp(attr.name, schema)}
      >
        {attr.name}
      </div>
      <ul className="min-w-0" title={lock || undefined}>
        {attr.masked ? (
          <li className="flex min-h-[18px] items-center gap-1 text-xs text-muted">
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
        {attr.truncated && (
          <li className="py-0.5 text-xs text-muted">Showing the first 10,000 values</li>
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

/**
 * A titled group of rows. Without setOpen it cannot close: it is open because the filter or a
 * problem shows rows in it. Closed rows stay in the page, hidden.
 */
function Section({
  title,
  help,
  attrs,
  open,
  setOpen,
  ...row
}: RowProps & {
  title: string
  help: string
  attrs: Attribute[]
  open: boolean
  setOpen?: (open: boolean) => void
}) {
  if (attrs.length === 0) return null
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section aria-label={title}>
      <button
        type="button"
        aria-expanded={open}
        title={setOpen ? help : `${help}. Open while the filter or a problem shows rows here`}
        disabled={!setOpen}
        onClick={() => setOpen?.(!open)}
        className="flex h-[26px] w-full items-center gap-1.5 border-b border-border bg-panel pr-4 pl-3 text-[11px] font-semibold tracking-[.04em] text-muted uppercase hover:text-fg disabled:hover:text-muted"
      >
        <Chevron aria-hidden className="h-3 w-3" />
        {title} <span className="font-normal tracking-normal">({attrs.length})</span>
      </button>
      <div hidden={!open}>
        {attrs.map((a) => (
          <AttributeRow key={a.name} attr={a} {...row} />
        ))}
      </div>
    </section>
  )
}

/**
 * The entry with its staged changes; editing turns values into editors. The card keeps filter and
 * operational (Operational open) from entry to entry; the other sections start open on each.
 */
export function Attributes({
  entry,
  editing,
  reload,
  filter,
  operational,
  setOperational,
}: {
  entry: Entry
  editing: boolean
  /** Refetches the entry. */
  reload: () => void
  /** The attribute filter's text. */
  filter: string
  operational: boolean
  setOperational: (open: boolean) => void
}) {
  const ws = useWorkspace()
  const batch = useBatch(ws.conn)
  const error = useBatchError(ws.conn, entry.dn)
  // The sections the person closed on this entry, by title.
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  // dropStale keeps the batch identity when no staged edit is stale.
  const stale = dropStale(batch, entry) !== batch
  const ec = entryChanges(batch, entry.dn)
  const viewed = view(entry, ec)
  const needle = filter.trim().toLowerCase()
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
  // The key attributes for the kind of entry lead, in their order, and are not repeated below.
  const classes =
    rows.find((a) => baseName(a.name) === 'objectclass')?.values?.map((v) => v.text) ?? []
  const pins = pinnedAttributes(entryKind(classes), ws.info.activeDirectory).map(attrKey)
  const pinned = pins.flatMap((k) => rows.filter((a) => attrKey(a.name) === k)).filter(matches)
  const g = groupAttributes(
    rows.filter((a) => !pins.includes(attrKey(a.name))),
    ws.schema,
  )
  const problems = validate(entry, ec, ws.schema)
  // A section stays as the person left it, but opens (and cannot close) while a row in it has a
  // problem to fix or a server error; Operational also while a filter is typed.
  const section = (
    title: string,
    attrs: Attribute[],
    open: boolean,
    setOpen: (open: boolean) => void,
    force = false,
  ) => {
    const forced = force || flagged(attrs, problems, error)
    return { title, attrs, open: open || forced, setOpen: forced ? undefined : setOpen }
  }
  const closable = (title: string, attrs: Attribute[]) =>
    section(title, attrs, !closed[title], (open) => setClosed((c) => ({ ...c, [title]: !open })))
  const sections = {
    pinned: closable('Pinned', pinned),
    must: closable('Required', g.must.filter(matches)),
    may: closable(ws.schema.available ? 'Optional' : 'Attributes', g.may.filter(matches)),
    ops: section(
      'Operational',
      g.operational.filter(matches),
      operational,
      setOperational,
      !!needle,
    ),
  }
  // Only rows in open sections are shown; the banner speaks for the rest.
  const shown = Object.values(sections).flatMap((s) => (s.open ? s.attrs.map((a) => a.name) : []))
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
      {!ws.schema.available && (
        <p className="px-2 py-1 text-xs text-warn">No schema: attributes are not grouped.</p>
      )}
      <Section
        {...sections.pinned}
        help="Key attributes of this kind of entry. They are not repeated in the sections below"
        {...row}
      />
      <Section {...sections.must} help="MUST attributes of the object classes" {...row} />
      <Section
        {...sections.may}
        help={
          ws.schema.available
            ? 'MAY attributes of the object classes'
            : 'Every attribute, ungrouped'
        }
        {...row}
      />
      <Section
        {...sections.ops}
        help="Server-maintained attributes, and those the object classes do not name"
        {...row}
      />
      {Object.values(sections).every((s) => s.attrs.length === 0) && (
        <p className="p-2 text-muted">No attributes match.</p>
      )}
      {/* The missing MUST rows are there to fill, so the picker does not offer them again. */}
      {editing && <AddAttribute entry={{ ...viewed, attributes: rows }} />}
    </div>
  )
}
