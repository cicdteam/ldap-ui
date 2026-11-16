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
import { classifyQuery } from '../../lib/query'
import type { SchemaIndex } from '../../lib/schema'

export interface FilterEditorHandle {
  focus(): void
}

// Coloring only; validation comes from lib/filter's parser through the linter.
export const filterLanguage = StreamLanguage.define<{ inValue: boolean }>({
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
    // Attribute descriptions, including extensible "cn:dn:2.5.13.5:" forms; on a line with no
    // "(" or "=", words of a name.
    if (stream.match(/^[^=~<>()\s]+/)) return /[(=]/.test(stream.string) ? 'propertyName' : null
    stream.next()
    return null
  },
})

export const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--accent-text)', fontWeight: '600' },
  { tag: tags.propertyName, color: 'var(--accent-text)' },
  { tag: tags.operator, color: 'var(--muted)' },
  { tag: tags.string, color: 'var(--fg)' },
  { tag: tags.escape, color: 'var(--danger)' },
  // The value wildcard: syntax, not an error.
  { tag: tags.atom, color: 'var(--accent-text)', fontWeight: '600' },
  { tag: tags.paren, color: 'var(--muted)' },
])

// One line in the header bar, whose box draws the border and the focus ring. While focused, a
// longer filter opens down over the panels (data-tall on the host, set below).
const theme = EditorView.theme({
  '&': { fontSize: '12.5px', color: 'var(--fg)', borderRadius: '6px' },
  '&.cm-focused': { outline: 'none', background: 'var(--bg)' },
  // The top padding and one 18px line.
  '.cm-scroller': { maxHeight: '21px', overflow: 'hidden', lineHeight: '18px' },
  '&.cm-focused .cm-scroller': { maxHeight: '12rem', overflow: 'auto' },
  '.cm-content': { fontFamily: 'var(--mono)', padding: '3px 0', caretColor: 'var(--fg)' },
  '.cm-placeholder': { color: 'var(--muted)', fontFamily: 'var(--sans)', fontSize: '13px' },
  // Popovers like the others: --bg, 10px corners, 6px items; the shadow is .elevated's, in index.css.
  '.cm-tooltip': {
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: '10px',
    color: 'var(--fg)',
  },
  '.cm-tooltip-autocomplete': { padding: '4px' },
  // Keeps the diagnostic's square left border inside the rounded corners.
  '.cm-tooltip-lint': { padding: '4px' },
  '.cm-tooltip-autocomplete ul li': { borderRadius: '6px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    background: 'var(--selected)',
    color: 'var(--fg)',
  },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--danger)' },
})

/** Only a filter is checked: a name or a DN is not one. */
function lint(text: string, baseDN: string): Diagnostic[] {
  if (classifyQuery(text, baseDN).kind !== 'filter') return []
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
  baseDN,
  ref,
}: {
  value: string
  onChange: (v: string) => void
  /** Enter and Mod-Enter, unless the completion list takes Enter. */
  onRun: () => void
  /** Shift-Alt-F: the owner formats value, as the palette's Format action does. */
  onFormat: () => void
  schema: SchemaIndex
  /** The connection's base DN, which tells a DN from a filter. */
  baseDN: string
  ref?: Ref<FilterEditorHandle>
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // The editor is created once; current props reach it through this ref.
  const latest = useRef({ onChange, onRun, onFormat, schema, baseDN })
  useLayoutEffect(() => {
    latest.current = { onChange, onRun, onFormat, schema, baseDN }
  })
  useImperativeHandle(ref, () => ({ focus: () => view.current?.focus() }), [])

  useEffect(() => {
    const complete = (ctx: CompletionContext): CompletionResult | null => {
      const { schema: s } = latest.current
      const before = ctx.state.sliceDoc(0, ctx.pos)
      // Plain text is usually a name: a list opening on "user" would take its Enter.
      if (!ctx.explicit && !before.includes('(')) return null
      const r = completeFilter(before, s.attrNames, s.classNames)
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
            ...['Enter', 'Mod-Enter'].map((key) => ({
              key,
              run: () => {
                latest.current.onRun()
                return true
              },
            })),
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          formatKey,
          filterLanguage,
          syntaxHighlighting(highlight),
          theme,
          EditorView.lineWrapping,
          placeholder('Search name, uid, mail, (filter) or DN'),
          linter((ed) => lint(ed.state.doc.toString(), latest.current.baseDN), { delay: 250 }),
          // A picked attribute or operator reopens the list with what can follow it.
          autocompletion({ override: [complete], activateOnCompletion: (c) => c.type !== 'class' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString())
            if (u.geometryChanged) {
              const { top, bottom } = u.view.documentPadding
              const text = u.view.contentHeight - top - bottom
              host.current?.toggleAttribute('data-tall', text > u.view.defaultLineHeight * 1.5)
            }
          }),
          EditorView.contentAttributes.of({
            'aria-label': 'Search by name, uid or mail, an LDAP filter, or a DN',
          }),
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

  return <div ref={host} className="absolute inset-x-0 top-[3px] z-30" />
}
