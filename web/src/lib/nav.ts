import type { SearchState } from './storage'
import type { Info, Scope } from './types'

/** Accepts only in-app workspace paths, so ?next= cannot redirect elsewhere. */
export function safeNext(next: string | null): string | undefined {
  if (!next || !next.startsWith('/c/') || next.startsWith('//') || next.includes('\\'))
    return undefined
  return next
}

/**
 * The route that reconnects the profile of a workspace path and comes back to it, or null
 * off the workspace. pathname keeps the --base-path prefix (router.state.location does);
 * the result is relative to the router basename, like routes and navigate().
 */
export function reconnectURL(pathname: string, search: string, basename: string): string | null {
  const path = basename === '/' ? pathname : pathname.slice(basename.length)
  const m = /^\/c\/([^/]+)/.exec(path)
  if (!m) return null
  return `/?${new URLSearchParams({ connect: decodeURIComponent(m[1]), next: path + search })}`
}

export function defaultColumns(info: Info): string[] {
  return info.activeDirectory
    ? ['cn', 'sAMAccountName', 'mail', 'objectClass']
    : ['cn', 'uid', 'mail', 'objectClass']
}

export function parseColumns(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of text.split(/[\s,]+/)) {
    if (c && !seen.has(c.toLowerCase())) {
      seen.add(c.toLowerCase())
      out.push(c)
    }
  }
  return out
}

const scopes: Scope[] = ['base', 'one', 'sub']

/** The search in the URL, or null when none has been run. */
export function readSearch(params: URLSearchParams): SearchState | null {
  const filter = params.get('filter')
  if (filter === null) return null
  const scope = params.get('scope') as Scope
  return {
    base: params.get('base') ?? '',
    scope: scopes.includes(scope) ? scope : 'sub',
    filter,
    attrs: parseColumns(params.get('attrs') ?? ''),
  }
}

export type View = 'entry' | 'search'

export interface WorkspaceState {
  /** The entry open in the inspector; empty for none. */
  dn: string
  search: SearchState | null
}

export function workspaceURL(conn: string, state: WorkspaceState, view: View): string {
  const p = new URLSearchParams()
  if (state.dn) p.set('dn', state.dn)
  if (state.search) {
    p.set('filter', state.search.filter)
    if (state.search.base) p.set('base', state.search.base)
    p.set('scope', state.search.scope)
    if (state.search.attrs.length) p.set('attrs', state.search.attrs.join(','))
  }
  const q = p.toString()
  return `/c/${encodeURIComponent(conn)}/${view}${q ? `?${q}` : ''}`
}
