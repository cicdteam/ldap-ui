import { invalidBatch, type Batch } from './changes'
import { sameDN } from './dn'
import { attrKey, type SchemaIndex } from './schema'
import type { ApiErrorBody, ApplyResult, Entry } from './types'

/**
 * The batch left after an apply of sent: an applied entry is removed (sameDN) only while its
 * changes are still the ones sent, so edits staged during the request survive. The same batch
 * if nothing is removed.
 */
export function afterApply(batch: Batch, sent: Batch, result: ApplyResult): Batch {
  const done = sent.filter((e) => result.applied.some((dn) => sameDN(dn, e.dn)))
  // ponytail: a changed entry is kept whole; its applied part then shows as stale marks to drop.
  const left = batch.filter(
    (e) =>
      !done.some(
        (d) => sameDN(d.dn, e.dn) && JSON.stringify(d.changes) === JSON.stringify(e.changes),
      ),
  )
  return left.length === batch.length ? batch : left
}

/** Whether Apply may run: batch non-empty, no invalid entry, prod confirm typed. */
export function canApply(opts: {
  batch: Batch
  invalid: number
  prod: boolean
  confirm: string
  conn: string
}): boolean {
  const { batch, invalid, prod, confirm, conn } = opts
  return batch.length > 0 && invalid === 0 && (!prod || confirm === conn)
}

/** Batch entries failing validation against their loaded entry; unloaded ones are not counted. */
export function invalidCount(batch: Batch, loaded: Entry[], schema: SchemaIndex): number {
  return batch.filter((ec) => invalidBatch([ec], loaded, schema)).length
}

/** What a stored apply error says: a conflict in plain words, else the server message. */
export function errorText(e: ApiErrorBody): string {
  return e.code === 'conflict' ? 'The entry changed since you read it.' : e.message
}

/** The message an attribute row shows: its validation problem, else a server error naming it. */
export function fieldMessage(
  attr: string,
  problems: Map<string, string>,
  error: ApiErrorBody | undefined,
): string | undefined {
  const key = attrKey(attr)
  if (problems.has(key)) return problems.get(key)
  if (error?.attribute && attrKey(error.attribute) === key) return errorText(error)
  return undefined
}

/**
 * Whether the entry banner shows its apply error: a conflict always (its actions live there),
 * any other error only when no shown row carries it (see fieldMessage).
 */
export function bannerShown(
  error: ApiErrorBody,
  shown: string[],
  problems: Map<string, string>,
): boolean {
  if (error.code === 'conflict' || !error.attribute) return true
  const key = attrKey(error.attribute)
  return problems.has(key) || !shown.some((a) => attrKey(a) === key)
}
