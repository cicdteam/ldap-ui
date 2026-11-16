import { createContext, useContext } from 'react'
import type { SchemaIndex } from '../lib/schema'
import type { SearchState } from '../lib/storage'
import type { Info } from '../lib/types'

export interface WorkspaceCtx {
  conn: string
  info: Info
  schema: SchemaIndex
  /** Set when the schema could not be read; the UI then runs without hints. */
  schemaError: unknown
  reloadSchema(): Promise<void>
  /** The entry in the inspector, '' for none. */
  dn: string
  search: SearchState | null
  /** Opens dn in the inspector; replace swaps the history entry (keyboard moves). */
  select(dn: string, opts?: { replace?: boolean }): void
  /** Runs s; null clears the search, so the results give way to the examples. */
  runSearch(s: SearchState | null): void
  /** Counts runs of the same search again, so its results start over. */
  runs: number
  toggleTree(): void
  toggleInspector(): void
}

export const WorkspaceContext = createContext<WorkspaceCtx | null>(null)

export function useWorkspace(): WorkspaceCtx {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace outside <Workspace>')
  return ctx
}
