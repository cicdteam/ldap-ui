import { normDN } from './dn'
import { stage as stageEdit, type Batch, type Edit } from './changes'
import { keys, load, save } from './storage'
import type { ApiErrorBody } from './types'

const UNDO_MAX = 100
const EMPTY: Batch = []

export interface BatchStore {
  get(conn: string): Batch
  stage(conn: string, dn: string, edit: Edit): void
  set(conn: string, batch: Batch): void
  /** Sets the batch and forgets its undo and redo: what was applied or discarded stays so. */
  reset(conn: string, batch: Batch): void
  undo(conn: string): boolean
  redo(conn: string): boolean
  clear(conn: string): void
  /** False while the batch is too large for sessionStorage: it lives in this tab only. */
  persisted(conn: string): boolean
  errorOf(conn: string, dn: string): ApiErrorBody | undefined
  setError(conn: string, dn: string, e: ApiErrorBody | undefined): void
  subscribe(fn: () => void): () => void
}

/** Staged batches per profile: sessionStorage-backed, undo in memory. */
export function createBatchStore(): BatchStore {
  const current = new Map<string, Batch>()
  const undo = new Map<string, Batch[]>()
  const redo = new Map<string, Batch[]>()
  const errors = new Map<string, Map<string, ApiErrorBody>>()
  const unsaved = new Set<string>()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((fn) => fn())

  const get = (conn: string): Batch => {
    let b = current.get(conn)
    if (!b) {
      const stored = load<Batch>(keys.batch(conn), EMPTY, 'session')
      b = Array.isArray(stored) && stored.length ? stored : EMPTY
      current.set(conn, b)
    }
    return b
  }
  const put = (conn: string, b: Batch) => {
    current.set(conn, b)
    // Over the sessionStorage quota (staged photos) the batch lives in this tab only, and the
    // stored copy goes, so a reload never brings back an older batch.
    if (save(keys.batch(conn), b, 'session')) unsaved.delete(conn)
    else {
      unsaved.add(conn)
      save(keys.batch(conn), EMPTY, 'session')
    }
    const errs = errors.get(conn)
    if (errs)
      for (const dn of [...errs.keys()]) if (!b.some((e) => normDN(e.dn) === dn)) errs.delete(dn)
    notify()
  }
  const set = (conn: string, b: Batch) => {
    if (!b.length) b = EMPTY
    const prev = get(conn)
    if (b === prev) return
    const stack = undo.get(conn) ?? []
    stack.push(prev)
    if (stack.length > UNDO_MAX) stack.shift()
    undo.set(conn, stack)
    redo.set(conn, [])
    put(conn, b)
  }
  const step = (conn: string, from: Map<string, Batch[]>, to: Map<string, Batch[]>) => {
    const stack = from.get(conn)
    const b = stack?.pop()
    if (!b) return false
    to.set(conn, [...(to.get(conn) ?? []), get(conn)])
    put(conn, b)
    return true
  }
  return {
    get,
    set,
    reset: (conn, b) => {
      undo.delete(conn)
      redo.delete(conn)
      put(conn, b.length ? b : EMPTY)
    },
    stage: (conn, dn, edit) => set(conn, stageEdit(get(conn), dn, edit)),
    undo: (conn) => step(conn, undo, redo),
    redo: (conn) => step(conn, redo, undo),
    clear: (conn) => {
      const hadErrors = errors.delete(conn)
      if (get(conn) !== EMPTY) set(conn, EMPTY)
      else if (hadErrors) notify()
    },
    persisted: (conn) => !unsaved.has(conn),
    errorOf: (conn, dn) => errors.get(conn)?.get(normDN(dn)),
    setError: (conn, dn, e) => {
      const m = errors.get(conn) ?? new Map<string, ApiErrorBody>()
      if (e) m.set(normDN(dn), e)
      else m.delete(normDN(dn))
      errors.set(conn, m)
      notify()
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

export const batches = createBatchStore()
