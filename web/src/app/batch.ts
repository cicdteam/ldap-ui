import type { QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { batches } from '../lib/batchStore'
import type { Batch } from '../lib/changes'
import type { ApiErrorBody } from '../lib/types'

export function useBatch(conn: string): Batch {
  return useSyncExternalStore(batches.subscribe, () => batches.get(conn))
}

export function useBatchError(conn: string, dn: string): ApiErrorBody | undefined {
  return useSyncExternalStore(batches.subscribe, () => batches.errorOf(conn, dn))
}

/** The apply mutation's key: whoever changes the batch checks it is not in flight. */
export const applyKey = (conn: string) => ['apply', conn] as const

/** Undo, or redo, of conn's batch; a no-op while an apply is in flight on it. */
export function stepBatch(qc: QueryClient, conn: string, redo: boolean): void {
  if (qc.isMutating({ mutationKey: applyKey(conn) })) return
  if (redo) batches.redo(conn)
  else batches.undo(conn)
}

// Stagings still reading what they stage from (a membership change reads the group), by key.
const reading = new Map<string, Promise<unknown>>()

/**
 * Runs stage, which reads before it stages, unless the same key's still runs: then that one's
 * promise comes back, so a field committed twice (Enter, then blur) stages once.
 */
export function stageOnce<T>(key: string, stage: () => Promise<T>): Promise<T> {
  const running = reading.get(key)
  if (running) return running as Promise<T>
  const p = stage()
  reading.set(key, p)
  const done = () => void reading.delete(key)
  p.then(done, done)
  return p
}

/** Settles once no staging is still reading: the review waits for it, so it has every change. */
export function stagingSettled(): Promise<unknown> {
  return Promise.allSettled(reading.values())
}
