import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import config from '../vite.config'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

it('keeps the exact base tag the Go server rewrites', () => {
  expect(html).toContain('<base href="/">')
})

it('puts the base tag before any asset reference', () => {
  expect(html.indexOf('<base href="/">')).toBeLessThan(html.indexOf('<script'))
})

it('builds assets relative to the base tag', () => {
  expect(config.base).toBe('./')
})
