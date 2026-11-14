import type { Scope } from './types'

/** Reads JSON from web storage; any failure (missing, disabled, junk) gives fallback. */
export function load<T>(key: string, fallback: T, area: 'local' | 'session' = 'local'): T {
  try {
    const store = area === 'session' ? sessionStorage : localStorage
    const s = store.getItem(key)
    return s === null ? fallback : (JSON.parse(s) as T)
  } catch {
    return fallback
  }
}

/** Writes JSON to web storage; false when that fails (storage disabled or full): the value then stays in memory only. */
export function save(key: string, value: unknown, area: 'local' | 'session' = 'local'): boolean {
  try {
    const store = area === 'session' ? sessionStorage : localStorage
    store.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export const keys = {
  theme: 'ldapui:theme',
  density: 'ldapui:density',
  raw: 'ldapui:raw',
  history: (profile: string) => `ldapui:history:${profile}`,
  saved: (profile: string) => `ldapui:saved:${profile}`,
  expanded: (profile: string) => `ldapui:expanded:${profile}`,
  batch: (profile: string) => `ldapui:batch:${profile}`,
}

export interface SearchState {
  /** Empty means the connection's base DN. */
  base: string
  scope: Scope
  filter: string
  attrs: string[]
}

export interface SavedSearch extends SearchState {
  name: string
}

const searchKey = (s: SearchState) => JSON.stringify([s.base, s.scope, s.filter, s.attrs])

/** Returns list with item first, without an older copy of it, at most max long. */
export function pushHistory(list: SearchState[], item: SearchState, max = 50): SearchState[] {
  const k = searchKey(item)
  const clean: SearchState = {
    base: item.base,
    scope: item.scope,
    filter: item.filter,
    attrs: item.attrs,
  }
  return [clean, ...list.filter((x) => searchKey(x) !== k)].slice(0, max)
}
