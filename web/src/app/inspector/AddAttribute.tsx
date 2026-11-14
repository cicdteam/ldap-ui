import { useId, useRef, useState } from 'react'
import { isBinaryAttr, needsBinaryOption, withBinaryOption } from '../../lib/binary'
import { batches } from '../../lib/batchStore'
import { addableAttributes, addAttributeProblem, editorKind } from '../../lib/edit'
import type { Entry } from '../../lib/types'
import { Input } from '../../ui/Input'
import { useWorkspace } from '../context'
import { UploadFile } from './Value'
import { keepFocusIn, ValueEditor } from './ValueEditor'

/**
 * "+ attribute": a name the entry's classes allow (any name without a schema), options included,
 * and its first value; a binary one takes a file instead, and Enter opens the file chooser.
 * Certificates get ;binary (RFC 4522).
 */
export function AddAttribute({ entry }: { entry: Entry }) {
  const ws = useWorkspace()
  const [name, setName] = useState('')
  const [fileError, setFileError] = useState('')
  const listId = useId()
  const file = useRef<HTMLInputElement>(null)
  const typed = name.trim()
  const attr = typed && needsBinaryOption(typed, ws.schema) ? withBinaryOption(typed) : typed
  const why = attr ? addAttributeProblem(attr, entry, ws.schema) : ''
  const binary = !!attr && !why && isBinaryAttr(attr, ws.schema)
  const kind = editorKind(attr, '', ws.schema)
  const added = () => {
    setName('')
    setFileError('')
    keepFocusIn(attr)
  }
  return (
    <div data-add-attribute className="flex flex-wrap items-center gap-2 p-2">
      <Input
        aria-label="Add attribute"
        placeholder="+ attribute"
        mono
        list={listId}
        value={name}
        onChange={(e) => {
          setName(e.target.value)
          setFileError('')
        }}
        onKeyDown={(e) => {
          // Enter is a user gesture, which a browser asks for before it opens a file chooser.
          if (e.key === 'Enter' && binary) {
            e.preventDefault()
            file.current?.click()
          }
        }}
        className="h-7 w-48"
      />
      <datalist id={listId}>
        {addableAttributes(entry, ws.schema).map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {why && <span className="text-xs text-muted">{why}</span>}
      {binary && (
        <UploadFile
          ref={file}
          attr={attr}
          onFile={(b64) => {
            batches.stage(ws.conn, entry.dn, { kind: 'add', attr, value: b64, base64: true })
            added()
          }}
          onError={setFileError}
        />
      )}
      {attr && !why && !binary && (
        // Keyed by kind: a draft for one editor makes no sense in another.
        <ValueEditor
          key={kind}
          attr={attr}
          value=""
          kind={kind}
          onCommit={(text) => {
            batches.stage(ws.conn, entry.dn, { kind: 'add', attr, value: text })
            added()
          }}
        />
      )}
      {fileError && (
        <p role="alert" className="w-full text-xs text-danger">
          {fileError}
        </p>
      )}
    </div>
  )
}
