import { useSyncExternalStore } from 'react'
import { keys, load, save } from './storage'

export type Theme = 'system' | 'light' | 'dark'
export type Density = 'comfortable' | 'compact'

export interface Prefs {
  theme: Theme
  density: Density
  /** Show raw attribute values instead of decoded ones. */
  raw: boolean
}

const themes: Theme[] = ['system', 'light', 'dark']
const densities: Density[] = ['comfortable', 'compact']

function initial(): Prefs {
  const theme = load<Theme>(keys.theme, 'system')
  const density = load<Density>(keys.density, 'comfortable')
  return {
    theme: themes.includes(theme) ? theme : 'system',
    density: densities.includes(density) ? density : 'comfortable',
    raw: load<unknown>(keys.raw, false) === true,
  }
}

let state = initial()
const listeners = new Set<() => void>()

export function getPrefs(): Prefs {
  return state
}

export function setPrefs(p: Partial<Prefs>): void {
  state = { ...state, ...p }
  save(keys.theme, state.theme)
  save(keys.density, state.density)
  save(keys.raw, state.raw)
  applyPrefs()
  listeners.forEach((fn) => fn())
}

export function usePrefs(): Prefs {
  return useSyncExternalStore((fn) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }, getPrefs)
}

/** Mirrors the prefs onto <html> data attributes that index.css keys on. */
export function applyPrefs(): void {
  const root = document.documentElement
  if (state.theme === 'system') delete root.dataset.theme
  else root.dataset.theme = state.theme
  root.dataset.density = state.density
}

export function nextTheme(t: Theme): Theme {
  return themes[(themes.indexOf(t) + 1) % themes.length]
}

/** Row height in px for virtual lists; keep in sync with --row in index.css. */
export function rowHeight(d: Density): number {
  return d === 'compact' ? 22 : 28
}
