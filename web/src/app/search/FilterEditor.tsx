import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { linter, type Diagnostic } from '@codemirror/lint'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react'
import { completeFilter, parse } from '../../lib/filter'
import type { SchemaIndex } from '../../lib/schema'

export interface FilterEditorHandle {
  focus(): void
}

// Coloring only; validation comes from lib/filter's parser through the linter.
const filterLanguage = StreamLanguage.define<{ inValue: boolean }>({
  startState: () => ({ inValue: false }),
  token(stream, state) {
    if (state.inValue) {
      if (stream.peek() === ')') {
        state.inValue = false
        stream.next()
        return 'paren'
      }
      if (stream.match(/^\\[0-9a-fA-F]{2}/)) return 'escape'
      if (stream.eat('*')) return 'atom'
      if (!stream.match(/^[^)\\*]+/)) stream.next()
      return 'string'
    }
    if (stream.eatSpace()) return null
    const ch = stream.peek()
    if (ch === '(' || ch === ')') {
      stream.next()
      return 'paren'
    }
    if (ch === '&' || ch === '|' || ch === '!') {
      stream.next()
      return 'keyword'
    }
    if (stream.match(/^(~=|>=|<=|:=|=)/)) {
      state.inValue = true
      return 'operator'
    }
    // Attribute descriptions, including extensible "cn:dn:2.5.13.5:" forms.
    if (stream.match(/^[^=~<>()\s]+/)) return 'propertyName'
    stream.next()
    return null
  },
})

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--accent)', fontWeight: '600' },
  { tag: tags.propertyName, fontWeight: '600' },
  { tag: tags.operator, color: 'var(--warn)' },
  { tag: tags.string, color: 'var(--ok)' },
  { tag: tags.escape, color: 'var(--danger)' },
  { tag: tags.atom, color: 'var(--danger)', fontWeight: '600' },
  { tag: tags.paren, color: 'var(--muted)' },
])

const theme = EditorView.theme({
  '&': {
    fontSize: '12.5px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    background: 'var(--bg)',
    color: 'var(--fg)',
  },
  '&.cm-focused': { outline: 'none', borderColor: 'var(--accent)' },
  '.cm-content': { fontFamily: 'var(--mono)', padding: '5px 0', caretColor: 'var(--fg)' },
  '.cm-scroller': { maxHeight: '12rem', overflow: 'auto' },
  '.cm-placeholder': { color: 'var(--muted)' },
  '.cm-tooltip': {
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    color: 'var(--fg)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    background: 'var(--selected)',
    color: 'var(--fg)',
  },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--danger)' },
})

function lint(text: string): Diagnostic[] {
  if (text.trim() === '') return []
  const r = parse(text)
  if (r.ok) return []
  return [
    {
      from: r.error.from,
      to: Math.max(r.error.to, r.error.from),
      severity: 'error',
      message: r.error.message,
    },
  ]
}

export function FilterEditor({
  value,
  onChange,
  onRun,
  onFormat,
  schema,
  ref,
}: {
  value: string
  onChange: (v: string) => void
  onRun: () => void
  /** Shift-Alt-F: the owner formats value, as the palette's Format action does. */
  onFormat: () => void
  schema: SchemaIndex
  ref?: Ref<FilterEditorHandle>
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // The editor is created once; current props reach it through this ref.
  const latest = useRef({ onChange, onRun, onFormat, schema })
  useLayoutEffect(() => {
    latest.current = { onChange, onRun, onFormat, schema }
  })
  useImperativeHandle(ref, () => ({ focus: () => view.current?.focus() }), [])

  useEffect(() => {
    const complete = (ctx: CompletionContext): CompletionResult | null => {
      const { schema: s } = latest.current
      const r = completeFilter(ctx.state.sliceDoc(0, ctx.pos), s.attrNames, s.classNames)
      if (!r || (r.options.length === 0 && !ctx.explicit)) return null
      // Values (objectClass names) start right after an operator.
      const value = ctx.state.sliceDoc(r.from - 1, r.from) === '='
      return {
        from: r.from,
        options: r.options.map((o) => ({
          label: o.label,
          detail: o.detail,
          type: o.detail ? 'keyword' : value ? 'class' : 'property',
        })),
      }
    }
    // Shift-Alt-F matched by physical key: on macOS Option-Shift-F types a
    // character, so a Shift-Alt-f keymap entry never fires.
    const formatKey = EditorView.domEventHandlers({
      keydown(e) {
        if (e.code !== 'KeyF' || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return false
        latest.current.onFormat()
        return true
      },
    })
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                latest.current.onRun()
                return true
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          formatKey,
          filterLanguage,
          syntaxHighlighting(highlight),
          theme,
          EditorView.lineWrapping,
          placeholder('(&(objectClass=person)(uid=jdoe))   empty matches everything'),
          linter((ed) => lint(ed.state.doc.toString()), { delay: 250 }),
          // A picked attribute or operator reopens the list with what can follow it.
          autocompletion({ override: [complete], activateOnCompletion: (c) => c.type !== 'class' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString())
          }),
          EditorView.contentAttributes.of({ 'aria-label': 'LDAP filter' }),
        ],
      }),
    })
    view.current = v
    return () => v.destroy()
    // Created once on mount; value changes are applied by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
    }
  }, [value])

  return <div ref={host} className="min-w-0 flex-1" />
}
