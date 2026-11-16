import { Download, Lock, Plus, Undo2, X } from 'lucide-react'
import type { ReactNode, Ref } from 'react'
import { base64ToBytes, fileName, readFile } from '../../lib/binary'
import type { Edit, Mark, MarkedValue } from '../../lib/changes'
import { byteLength, formatDisplay, imageType } from '../../lib/display'
import { editorKind, isRDNValue } from '../../lib/edit'
import { usePrefs } from '../../lib/prefs'
import { baseName, type SchemaIndex } from '../../lib/schema'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { CopyButton } from '../../ui/CopyButton'
import { download } from '../../ui/download'
import { useWorkspace } from '../context'
import { ValueEditor } from './ValueEditor'

const DANGER_FLAGS = new Set(['ACCOUNTDISABLE', 'LOCKOUT', 'PASSWORD_EXPIRED'])

// NameAndOptionalUID values (uniqueMember) may end in a bit string UID: "dn#'0101'B".
const OPTIONAL_UID = /#'[01]*'B$/

const RENAMING = 'Change the RDN with Rename/Move'

// A value's own icon buttons: the height of its line.
const SMALL = 'h-[18px]! w-[18px]!'

export const MARKS: Record<Mark, { row: string; glyph: string; tone: string }> = {
  added: { row: 'border-l-2 border-ok', glyph: '+', tone: 'text-ok' },
  changed: { row: 'border-l-2 border-warn', glyph: '~', tone: 'text-warn' },
  deleted: {
    row: 'border-l-2 border-danger line-through text-muted',
    glyph: '-',
    tone: 'text-danger',
  },
  stale: { row: 'border-l-2 border-danger', glyph: '!', tone: 'text-danger' },
}
const STALE = 'This change no longer applies: the entry changed'

/** The staged change a value shows: its glyph, named for screen readers. */
export function MarkGlyph({ mark }: { mark?: Mark }) {
  if (!mark) return null
  return (
    <span
      role="img"
      aria-label={mark}
      className={cn('w-3 shrink-0 self-center text-center font-mono text-xs', MARKS[mark].tone)}
    >
      {MARKS[mark].glyph}
    </span>
  )
}

export function ValueView({
  attr,
  dn,
  index,
  value,
  schema,
  title,
  actions,
}: {
  attr: string
  /** The entry's DN and the value's index in attr: they name a downloaded file. */
  dn: string
  index: number
  value: MarkedValue
  schema: SchemaIndex
  /** Why the value cannot be edited, in edit mode. */
  title?: string
  actions?: ReactNode
}) {
  const ws = useWorkspace()
  const { raw } = usePrefs()
  const copyText = value.text
  let body
  if (raw) {
    body = (
      <span className="font-mono text-xs break-all whitespace-pre-wrap">
        {/* A binary value would be a wall of base64: Copy and Download carry it. */}
        {value.base64 ? `base64, ${byteLength(value.text)} bytes` : value.text}
      </span>
    )
  } else if (value.base64 && schema.isImage(attr) && imageType(value.text)) {
    body = (
      <img
        src={`data:${imageType(value.text)};base64,${value.text}`}
        alt={`${attr} (${byteLength(value.text)} bytes)`}
        className="max-h-24 rounded border border-border"
      />
    )
  } else if (!value.base64 && schema.isDN(attr)) {
    body = (
      <button
        type="button"
        onClick={() => ws.select(value.text.replace(OPTIONAL_UID, ''))}
        className="text-left font-mono text-xs break-all text-accent-text hover:underline"
      >
        {value.text}
      </button>
    )
  } else if (baseName(attr) === 'useraccountcontrol' && value.display) {
    body = (
      <span className="flex flex-wrap items-center gap-1">
        {value.display
          .split(' ')
          .filter(Boolean)
          .map((f) => (
            <Badge key={f} shape="chip" tone={DANGER_FLAGS.has(f) ? 'danger' : 'neutral'}>
              {f}
            </Badge>
          ))}
        <span className="font-mono text-[11px] text-muted">{value.text}</span>
      </span>
    )
  } else if (value.display !== undefined) {
    body = (
      <span className="font-mono text-xs break-all" title={value.text}>
        {formatDisplay(value)}
      </span>
    )
  } else if (value.base64) {
    body = <span className="text-xs text-muted">binary, {byteLength(value.text)} bytes</span>
  } else {
    body = <span className="font-mono text-xs break-all whitespace-pre-wrap">{value.text}</span>
  }
  return (
    <li
      className={cn('group flex items-start gap-1', value.mark && MARKS[value.mark].row)}
      title={value.mark === 'stale' ? STALE : title}
    >
      <MarkGlyph mark={value.mark} />
      <div className="min-w-0 flex-1 leading-[18px]">{body}</div>
      {/* opacity, not visibility: a hidden button would drop out of the tab order */}
      <span className="flex opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        {/* 18 px, the value's line: a row stays 30 px tall. */}
        <CopyButton text={copyText} label={`Copy ${attr} value`} className={SMALL} />
        {value.base64 && (
          // Built from the value already loaded: no request, any profile.
          <Button
            size="icon"
            variant="ghost"
            className={SMALL}
            aria-label={`Download ${attr} value`}
            title="Download this value as a file"
            onClick={() =>
              download(
                fileName(dn, attr, index, value.text, schema),
                base64ToBytes(value.text),
                imageType(value.text) ?? 'application/octet-stream',
              )
            }
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        )}
      </span>
      {actions}
    </li>
  )
}

/** One value in edit mode: an editor, or the view with why not. */
export function EditValue({
  attr,
  dn,
  index,
  value,
  schema,
  stage,
  fixed,
}: {
  attr: string
  dn: string
  /** The value's index in attr. */
  index: number
  value: MarkedValue
  schema: SchemaIndex
  stage: (e: Edit) => void
  /** objectClass values are never edited in place: '' when the value can be deleted, else why not. */
  fixed?: string
}) {
  const del: Edit = { kind: 'delete', attr, value: value.text, base64: value.base64 }
  const props = { attr, dn, index, value, schema }
  // ponytail: stale values are read-only here; they are dropped as a whole, not edited.
  if (value.mark === 'stale') return <ValueView {...props} />
  if (value.mark === 'deleted') {
    return (
      <ValueView
        {...props}
        actions={
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Restore ${attr} value`}
            title="Restore value"
            onClick={() => stage({ kind: 'add', attr, value: value.text, base64: value.base64 })}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
        }
      />
    )
  }
  const remove = (why: string) => (
    <Button
      size="icon"
      variant="ghost"
      aria-label={`Delete ${attr} value`}
      title={why || 'Delete value'}
      disabled={!!why}
      // Keeps focus in the editor, so its blur does not stage the draft in place of the delete.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => stage(del)}
    >
      <X className="h-3.5 w-3.5" />
    </Button>
  )
  if (fixed !== undefined)
    return (
      <ValueView
        {...props}
        title={fixed || undefined}
        actions={
          fixed ? (
            <span
              role="img"
              aria-label={fixed}
              title={fixed}
              className="flex h-7 w-7 items-center justify-center text-muted"
            >
              <Lock className="h-3.5 w-3.5" />
            </span>
          ) : (
            remove('')
          )
        }
      />
    )
  // A binary value is kept or deleted; replacing it is a delete and an upload.
  if (value.base64) return <ValueView {...props} actions={remove('')} />
  // Changing an RDN value deletes it too, so it is not edited in place either.
  if (isRDNValue(dn, attr, value.text))
    return <ValueView {...props} title={RENAMING} actions={remove(RENAMING)} />
  return (
    <li className={cn('flex items-start gap-1 py-0.5', value.mark && MARKS[value.mark].row)}>
      <MarkGlyph mark={value.mark} />
      <ValueEditor
        attr={attr}
        value={value.text}
        kind={editorKind(attr, value.text, schema)}
        onCommit={(t) => stage(t === '' ? del : { kind: 'replace', attr, from: value.text, to: t })}
      />
      {remove('')}
    </li>
  )
}

/**
 * "+ Upload file…": a file input dressed as a button. The chosen file goes to onFile as base64
 * (see readFile), or why not to onError. ref reaches the input, so a key can open the chooser.
 */
export function UploadFile({
  attr,
  onFile,
  onError,
  ref,
}: {
  attr: string
  onFile: (b64: string) => void
  onError: (message: string) => void
  ref?: Ref<HTMLInputElement>
}) {
  return (
    // relative: the sr-only input is absolute; without a positioned ancestor it sits
    // against the page and stretches it, and focusing it scrolls the whole page.
    <label className="relative inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium whitespace-nowrap text-muted focus-within:ring-1 focus-within:ring-accent hover:bg-hover hover:text-fg">
      <Plus className="h-3.5 w-3.5" /> Upload file…
      <input
        ref={ref}
        type="file"
        aria-label={`Upload ${attr} file`}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Cleared, so choosing the same file again is a change too.
          e.target.value = ''
          if (file) readFile(file).then(onFile, (err: Error) => onError(err.message))
        }}
      />
    </label>
  )
}
