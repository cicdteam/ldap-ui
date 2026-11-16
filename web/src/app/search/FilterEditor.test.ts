import { highlightTree } from '@lezer/highlight'
import { expect, it } from 'vitest'
import { filterLanguage, highlight } from './FilterEditor'

// Each highlighted token of text with the CSS declarations its classes get.
function styled(text: string): [string, string][] {
  const rules = highlight.module!.getRules()
  const out: [string, string][] = []
  highlightTree(filterLanguage.parser.parse(text), highlight, (from, to, classes) => {
    const css = classes
      .split(' ')
      .map((c) => rules.match(new RegExp(`\\.${c}\\s*\\{([^}]*)\\}`))?.[1].trim())
      .join(' ')
    out.push([text.slice(from, to), css])
  })
  return out
}

it('colors the value wildcard as accent text, an escape as danger', () => {
  const got = styled('(cn=a*\\2a)')
  expect(got).toContainEqual(['*', 'color: var(--accent-text); font-weight: 600;'])
  expect(got).toContainEqual(['\\2a', 'color: var(--danger);'])
})

it('leaves a plain name uncolored, an attribute in a filter colored', () => {
  expect(styled('john doe')).toEqual([])
  expect(styled('uid=jdoe')).toContainEqual(['uid', 'color: var(--accent-text);'])
})
