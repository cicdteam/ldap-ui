import { highlightTree, type Tag } from '@lezer/highlight'
import { expect, it } from 'vitest'
import { filterLanguage } from './FilterEditor'

// Each highlighted token of text with the names of its highlight tags.
function tagged(text: string): [string, string][] {
  const out: [string, string][] = []
  const byName = { style: (tags: readonly Tag[]) => tags.join(' ') }
  highlightTree(filterLanguage.parser.parse(text), byName, (from, to, names) => {
    out.push([text.slice(from, to), names])
  })
  return out
}

it('tags the value wildcard as an atom, an escape as an escape', () => {
  const got = tagged('(cn=a*\\2a)')
  expect(got).toContainEqual(['*', 'atom'])
  expect(got).toContainEqual(['\\2a', 'escape'])
})

it('leaves a plain name untagged, an attribute in a filter tagged', () => {
  expect(tagged('john doe')).toEqual([])
  expect(tagged('uid=jdoe')).toContainEqual(['uid', 'propertyName'])
})
