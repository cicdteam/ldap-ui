import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

// The custom properties declared in the first `<selector> {` block of index.css.
function vars(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`no ${selector} block in index.css`)
  const body = css.slice(start, css.indexOf('}', start))
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  )
}

// WCAG 2 relative luminance of a #rrggbb color.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const themes = { light: vars(':root'), dark: vars(":root[data-theme='dark']") }

const pairs: [string, string, number][] = [
  ['--fg', '--bg', 7],
  ['--fg', '--panel', 7],
  ...['--muted', '--accent-text', '--danger', '--warn', '--ok'].flatMap((fg) =>
    ['--bg', '--panel', '--chrome'].map((bg): [string, string, number] => [fg, bg, 4.5]),
  ),
  ['--accent-fg', '--accent', 4.5],
]

describe.each(Object.entries(themes))('%s theme', (_, t) => {
  it.each(pairs)('%s on %s is at least %d:1', (fg, bg, min) => {
    expect(t[fg], fg).toMatch(/^#[0-9a-f]{6}$/i)
    expect(t[bg], bg).toMatch(/^#[0-9a-f]{6}$/i)
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(min)
  })
})

it('repeats the dark values for the system dark scheme', () => {
  expect(vars(":root:not([data-theme='light'])")).toEqual(themes.dark)
})

// Accent as text fails 4.5:1 on dark; both the class and a style object's color are caught.
it('colors accent text with accent-text, never the accent', () => {
  const src = new URL('..', import.meta.url)
  const offenders = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .filter((f) => {
      const code = readFileSync(new URL(f, src), 'utf8')
      return (
        /\btext-accent(?![-\w])/.test(code) ||
        /(?<![\w-])color['"]?\s*:\s*['"`]?var\(--accent\)/.test(code)
      )
    })
  expect(offenders).toEqual([])
})
