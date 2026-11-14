import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { isBinaryAttr } from '../../lib/binary'
import { auxiliaryCandidates, editorKind, lockReason, structuralChoices } from '../../lib/edit'
import {
  addableToForm,
  formDN,
  formMust,
  isMustRow,
  rdnChoices,
  withClasses,
  type EntryForm,
  type FormAttr,
} from '../../lib/entryOps'
import { attributeHelp, attrKey } from '../../lib/schema'
import { Button } from '../../ui/Button'
import { Input, inputLook } from '../../ui/Input'
import { useWorkspace } from '../context'
import { ValueEditor } from '../inspector/ValueEditor'
import { UploadFile, ValueView } from '../inspector/Value'
import { Field } from './WriteDialog'

const select = `h-7 px-2 text-xs ${inputLook}`

/** The fields of a new entry: parent, classes, RDN and attribute rows. */
export function EntryFields({
  form,
  onChange,
  problems,
  fieldError,
  focusRDN,
}: {
  form: EntryForm
  onChange: (f: EntryForm) => void
  problems: Map<string, string>
  /** A server error about one attribute of the form, shown at its row. */
  fieldError?: { attr: string; message: string }
  focusRDN?: boolean
}) {
  const ws = useWorkspace()
  const schema = ws.schema
  const set = (patch: Partial<EntryForm>) => onChange({ ...form, ...patch })
  const setClasses = (classes: string[]) =>
    onChange(withClasses(form, classes, schema, ws.info.activeDirectory))
  const message = (attr: string) =>
    problems.get(attrKey(attr)) ??
    (fieldError && attrKey(fieldError.attr) === attrKey(attr) ? fieldError.message : undefined)
  const must = formMust(form.classes, schema)
  const rdnRow = form.attrs.some((a) => attrKey(a.name) === attrKey(form.rdnAttr))
  const rdnMessage = rdnRow ? undefined : message(form.rdnAttr)
  // Free text keeps what is typed (spaces too); the classes are what it splits into.
  const [classText, setClassText] = useState(form.classes.join(' '))
  return (
    <div className="space-y-2">
      <Field label="Parent">
        <ValueEditor
          attr="parent"
          label="Parent"
          value={form.parent}
          kind="dn"
          onCommit={(t) => set({ parent: t })}
          onDraft={(t) => set({ parent: t })}
        />
      </Field>
      {schema.available ? (
        <>
          <Field label="Structural class">
            <select
              aria-label="Structural class"
              className={select}
              value={form.classes[0] ?? ''}
              onChange={(e) => setClasses([e.target.value, ...form.classes.slice(1)])}
            >
              <option value="" disabled>
                Choose a class
              </option>
              {structuralChoices(schema, ws.info.activeDirectory).map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Auxiliary classes">
            {form.classes.slice(1).map((c) => (
              <span
                key={c}
                className="flex items-center gap-1 rounded border border-border pl-1 font-mono text-xs"
              >
                {c}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${c} class`}
                  onClick={() => setClasses(form.classes.filter((x) => x !== c))}
                >
                  <X className="h-3 w-3" />
                </Button>
              </span>
            ))}
            <select
              aria-label="Add auxiliary class"
              className={select}
              value=""
              disabled={!form.classes[0]}
              onChange={(e) => {
                if (e.target.value) setClasses([...form.classes, e.target.value])
              }}
            >
              <option value="">+ class</option>
              {auxiliaryCandidates(form.classes, schema).map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
        </>
      ) : (
        <Field label="Object classes">
          <Input
            aria-label="Object classes"
            mono
            className="flex-1"
            placeholder="inetOrgPerson posixAccount"
            value={classText}
            onChange={(e) => {
              setClassText(e.target.value)
              set({ classes: e.target.value.split(/[\s,]+/).filter(Boolean) })
            }}
          />
        </Field>
      )}
      <Field label="RDN">
        {schema.available ? (
          <select
            aria-label="RDN attribute"
            className={select}
            value={form.rdnAttr}
            onChange={(e) => set({ rdnAttr: e.target.value })}
          >
            {rdnChoices(form.classes, schema).map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        ) : (
          <Input
            aria-label="RDN attribute"
            mono
            className="h-7 w-28"
            value={form.rdnAttr}
            onChange={(e) => set({ rdnAttr: e.target.value.trim() })}
          />
        )}
        <span className="font-mono text-xs">=</span>
        <Input
          aria-label="RDN value"
          mono
          data-autofocus={focusRDN || undefined}
          className="h-7 flex-1"
          value={form.rdnValue}
          onChange={(e) => set({ rdnValue: e.target.value })}
        />
      </Field>
      {rdnMessage && (
        <p role="alert" className="text-xs text-danger">
          {rdnMessage}
        </p>
      )}
      {form.attrs.map((a) => (
        <AttrRow
          key={a.name}
          attr={a}
          dn={formDN(form)}
          must={isMustRow(a.name, must, schema)}
          message={message(a.name)}
          onChange={(row) => set({ attrs: form.attrs.map((x) => (x === a ? row : x)) })}
          onRemove={() => set({ attrs: form.attrs.filter((x) => x !== a) })}
        />
      ))}
      <AddField
        form={form}
        onAdd={(name) => set({ attrs: [...form.attrs, { name, values: [] }] })}
      />
    </div>
  )
}

function AttrRow({
  attr,
  dn,
  must,
  message,
  onChange,
  onRemove,
}: {
  attr: FormAttr
  /** The DN the form creates: it names a downloaded file. */
  dn: string
  must: boolean
  message: string | undefined
  onChange: (row: FormAttr) => void
  onRemove: () => void
}) {
  const ws = useWorkspace()
  // Why the last chosen file was not taken (too large, empty).
  const [fileError, setFileError] = useState('')
  const files = attr.binary ?? []
  const binary = isBinaryAttr(
    attr.name,
    ws.schema,
    files.map((text) => ({ text, base64: true })),
  )
  // An empty text row still shows one blank field to type into; a binary row lists its files.
  const slots = attr.values.length || binary ? attr.values : ['']
  const put = (i: number) => (t: string) =>
    onChange({ ...attr, values: slots.map((x, j) => (j === i ? t : x)) })
  const single = !!ws.schema.attr(attr.name)?.singleValue
  const shown = message ?? (fileError || undefined)
  return (
    <div data-attr={attr.name} className="grid grid-cols-[minmax(7rem,11rem)_1fr] gap-2">
      <div
        className="truncate pt-1.5 font-mono text-xs font-semibold"
        title={attributeHelp(attr.name, ws.schema)}
      >
        {attr.name}
      </div>
      <div className="min-w-0 space-y-1">
        {/* ponytail: keyed by index; values are only ever appended or cleared, never removed. */}
        {slots.map((v, i) => (
          <div key={i} className="flex">
            <ValueEditor
              attr={attr.name}
              value={v}
              kind={editorKind(attr.name, v, ws.schema)}
              onCommit={put(i)}
              onDraft={put(i)}
            />
          </div>
        ))}
        {files.length > 0 && (
          <ul>
            {files.map((text, i) => (
              <ValueView
                key={`${i}:${text.slice(0, 32)}`}
                attr={attr.name}
                dn={dn}
                index={i}
                value={{ text, base64: true }}
                schema={ws.schema}
                actions={
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${attr.name} value`}
                    title="Delete value"
                    onClick={() => onChange({ ...attr, binary: files.filter((_, j) => j !== i) })}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                }
              />
            ))}
          </ul>
        )}
        <div className="flex gap-1">
          {binary
            ? (!single || files.length === 0) && (
                <UploadFile
                  attr={attr.name}
                  onFile={(b64) => {
                    setFileError('')
                    if (!files.includes(b64)) onChange({ ...attr, binary: [...files, b64] })
                  }}
                  onError={setFileError}
                />
              )
            : !single && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Add ${attr.name} value`}
                  onClick={() => onChange({ ...attr, values: [...slots, ''] })}
                >
                  <Plus className="h-3.5 w-3.5" /> value
                </Button>
              )}
          {!must && (
            <Button size="sm" variant="ghost" aria-label={`Remove ${attr.name}`} onClick={onRemove}>
              <X className="h-3.5 w-3.5" /> remove
            </Button>
          )}
        </div>
        {shown && (
          <p role="alert" className="text-xs text-danger">
            {shown}
          </p>
        )}
      </div>
    </div>
  )
}

/** "+ attribute": a MUST/MAY name the form lacks, or any name without a schema (Enter adds it). */
function AddField({ form, onAdd }: { form: EntryForm; onAdd: (name: string) => void }) {
  const ws = useWorkspace()
  const [name, setName] = useState('')
  if (ws.schema.available) {
    const options = addableToForm(form, ws.schema)
    if (!options.length) return null
    return (
      <select
        aria-label="Add attribute"
        className={select}
        value=""
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value)
        }}
      >
        <option value="">+ attribute</option>
        {options.map((n) => (
          <option key={n}>{n}</option>
        ))}
      </select>
    )
  }
  const n = name.trim()
  const lock = n ? lockReason(n, ws.schema) : ''
  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label="Add attribute"
        mono
        placeholder="+ attribute"
        className="h-7 w-40"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault() // not the form's submit
          if (n && !lock && !form.attrs.some((a) => attrKey(a.name) === attrKey(n))) {
            onAdd(n)
            setName('')
          }
        }}
      />
      {lock && <span className="text-xs text-muted">{lock}</span>}
    </div>
  )
}
