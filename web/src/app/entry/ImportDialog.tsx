import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, errorMessage } from '../../lib/api'
import { visible, type Tone } from '../../lib/display'
import { parentDN, rdnDisplay, sameDN, splitDN } from '../../lib/dn'
import {
  addFailure,
  addRequest,
  commonBase,
  defaultTarget,
  endsRun,
  failedLDIF,
  MAX_IMPORT_RECORDS,
  parseLDIF,
  planImport,
  precheck,
  type LdifRecord,
  type Outcome,
  type PlanItem,
} from '../../lib/ldifImport'
import { plural } from '../../lib/status'
import { Badge } from '../../ui/Badge'
import { Banner, ErrorBanner } from '../../ui/Banner'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { CopyButton } from '../../ui/CopyButton'
import { Dialog } from '../../ui/Dialog'
import { Input, inputLook } from '../../ui/Input'
import { useWorkspace } from '../context'
import { afterWrite } from '../queries'
import { Field } from './WriteDialog'

const dots = {
  new: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-danger',
  skip: 'bg-border-strong',
  wait: 'border border-border-strong',
}
const tags = {
  new: 'text-muted',
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-danger',
  skip: 'text-muted',
  wait: 'text-muted',
}
interface Row {
  dn: string
  tone: keyof typeof dots
  tag: string
}

function outcomeRow(dn: string, o: Outcome): Row {
  switch (o.kind) {
    case 'created':
      return { dn, tone: 'ok', tag: 'created' }
    case 'exists':
      return { dn, tone: 'skip', tag: 'already exists, skipped' }
    case 'failed':
      return { dn, tone: 'bad', tag: o.message }
    case 'not-imported':
      return {
        dn,
        tone: 'warn',
        tag: `not imported: ${o.reason === 'parent' ? 'parent not created' : 'stopped'}`,
      }
    case 'unsupported':
      return { dn, tone: 'skip', tag: o.reason }
  }
}

function Rows({ rows }: { rows: Row[] }) {
  return (
    <ul className="max-h-64 overflow-auto font-mono text-xs">
      {rows.map((r, i) => (
        <li
          key={i}
          className="flex items-baseline gap-2 border-t border-border px-2 py-1 first:border-t-0"
        >
          <i aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', dots[r.tone])} />
          {/* Both wrap: the DN and the server's message are what a fix needs. */}
          <span className="min-w-0 flex-1 break-all">{visible(r.dn)}</span>
          <span className={cn('max-w-[50%] text-right font-sans break-words', tags[r.tone])}>
            {r.tag}
          </span>
        </li>
      ))}
    </ul>
  )
}

function Box({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="rounded-md border border-border">
      <h3 className="flex items-baseline gap-2 border-b border-border bg-chrome px-2 py-1.5 text-xs font-semibold">
        {title}
        {note && <span className="font-normal text-muted">{note}</span>}
      </h3>
      {children}
    </section>
  )
}

type Chip = [number, string, string, Tone?]

/** Counts as chips: [n, one, many, tone]; a chip with n 0 shows only when keep is set. */
function Chips({ chips, keep }: { chips: Chip[]; keep?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips
        .filter(([n]) => keep || n > 0)
        .map(([n, one, many, tone]) => (
          <Badge key={many} tone={tone}>
            {plural(n, one, many)}
          </Badge>
        ))}
    </div>
  )
}

/**
 * Import LDIF: paste, open or drop a file; preview the plan (base swap, left-out attributes,
 * warnings); create the entries one at a time, parents first; then a report. Nothing is written
 * before Import, and the dialog does not close while the import runs.
 */
export function ImportDialog({ here, close }: { here?: string; close: () => void }) {
  const ws = useWorkspace()
  const qc = useQueryClient()
  const file = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<unknown>(null)
  const [records, setRecords] = useState<LdifRecord[] | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const plan = useMemo(
    () => records && planImport(records, from, to, ws.schema),
    [records, from, to, ws.schema],
  )
  // By PlanItem.dn, in the order they came; null until Import.
  const [outcomes, setOutcomes] = useState<Map<string, Outcome> | null>(null)
  const [current, setCurrent] = useState('')
  const [running, setRunning] = useState(false)
  // The error that ended the run, if one did.
  const [ended, setEnded] = useState<unknown>(null)
  const stop = useRef(false)
  const [stopping, setStopping] = useState(false)
  // Leaving the workspace mid-run stops it after the request in flight: no writes out of sight.
  useEffect(
    () => () => {
      stop.current = true
    },
    [],
  )

  const load = async (f: File) => {
    setText(await f.text())
    setProblem(null)
  }
  const preview = () => {
    try {
      const rs = parseLDIF(text)
      if (rs.length === 0) throw new Error('No records found')
      if (rs.length > MAX_IMPORT_RECORDS)
        throw new Error(
          `${rs.length.toLocaleString('en-US')} records: an import takes at most ${MAX_IMPORT_RECORDS.toLocaleString('en-US')}`,
        )
      // Parent DNs, so a top entry (ou=Staff) keeps its level under the new base.
      const base = commonBase(rs.map((r) => parentDN(r.entry.dn)))
      setFrom(base)
      setTo(defaultTarget(base, ws.info, here))
      setRecords(rs)
      setProblem(null)
    } catch (e) {
      setProblem(e)
    }
  }
  const start = async (items: PlanItem[]) => {
    stop.current = false
    setRunning(true)
    const done = new Map<string, Outcome>()
    setOutcomes(done)
    let i = 0
    for (; i < items.length && !stop.current; i++) {
      const item = items[i]
      let o = precheck(item, done)
      if (!o) {
        setCurrent(item.dn)
        try {
          await api.addEntry(ws.conn, addRequest(item))
          o = { kind: 'created' }
        } catch (e) {
          o = addFailure(e)
          if (endsRun(e)) {
            stop.current = true
            setEnded(e)
          }
        }
      }
      done.set(item.dn, o)
      // ponytail: a copy per entry, O(n^2) at 5000 next to 5000 adds; a ref and a counter if it shows.
      setOutcomes(new Map(done))
    }
    // Not tried: unsupported or below a failed entry as before, else stopped.
    for (; i < items.length; i++)
      done.set(items[i].dn, precheck(items[i], done) ?? { kind: 'not-imported', reason: 'stopped' })
    setOutcomes(new Map(done))
    setCurrent('')
    setRunning(false)
    afterWrite(qc, ws.conn)
  }

  const supported = plan?.items.filter((i) => !i.unsupported) ?? []
  const all = [...(outcomes ?? [])]
  const count = (kind: Outcome['kind']) => all.filter(([, o]) => o.kind === kind).length
  const progress = all.length - count('unsupported')

  let title = 'Import LDIF'
  let description = ws.conn
  let body: ReactNode
  if (!plan) {
    body = (
      <div
        className="space-y-3"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          // A file only: dropped text goes into the textarea as usual.
          const f = e.dataTransfer.files[0]
          if (!f) return
          e.preventDefault()
          void load(f)
        }}
      >
        <div className="flex items-center gap-2 rounded-md border border-dashed border-border-strong bg-chrome p-2">
          <Button onClick={() => file.current?.click()}>Open file…</Button>
          <input
            ref={file}
            type="file"
            accept=".ldif,text/plain"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void load(f)
              e.target.value = ''
            }}
          />
          <span className="text-xs text-muted">
            or drop an .ldif file here, or paste below. Up to{' '}
            {MAX_IMPORT_RECORDS.toLocaleString('en-US')} entries.
          </span>
        </div>
        <textarea
          aria-label="LDIF"
          data-autofocus
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setProblem(null)
          }}
          className={cn(inputLook, 'block min-h-72 w-full resize-y p-2 font-mono text-xs')}
        />
        {problem ? <ErrorBanner error={problem} /> : null}
        <div className="flex items-center gap-2">
          <span className="flex-1 text-xs text-muted">
            Records are read in your browser; nothing is written until you press Import.
          </span>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!text.trim()} onClick={preview}>
            Preview
          </Button>
        </div>
      </div>
    )
  } else if (!outcomes) {
    description = plural(records?.length ?? 0, 'record read', 'records read')
    const why =
      from && !to.trim() ? 'Becomes is empty' : supported.length ? '' : 'Nothing to import'
    body = (
      <div className="space-y-3">
        <Chips
          chips={[
            [supported.length, 'entry to create', 'entries to create'],
            [
              supported.filter((i) => i.warnings.length).length,
              'with warnings',
              'with warnings',
              'warn',
            ],
            [plan.items.length - supported.length, 'not supported', 'not supported', 'danger'],
            [
              plan.leftOut.length,
              'server-managed attribute left out',
              'server-managed attributes left out',
            ],
            [plan.passwords, 'password value left out', 'password values left out', 'warn'],
          ]}
        />
        <Box title="Place under this directory">
          <div className="space-y-1.5 p-2">
            <Field label="Their base">
              <Input
                mono
                aria-label="Their base"
                className="h-7 flex-1"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <Field label="Becomes">
              <Input
                mono
                aria-label="Becomes"
                className="h-7 flex-1"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
            <p className="text-xs text-muted">
              {!from ? (
                'The DNs have no common base: they are created as they are.'
              ) : !to.trim() ? (
                'Name the entry their base becomes.'
              ) : sameDN(from, to) ? (
                'The DNs stay as they are.'
              ) : (
                <>
                  Every DN under <b className="font-medium text-fg">{visible(from)}</b> moves under{' '}
                  <b className="font-medium text-fg">{visible(to)}</b>, and so do the values that
                  hold such DNs (member, manager, seeAlso…).
                </>
              )}
            </p>
          </div>
        </Box>
        <Box title="Entries" note="parents first, in the order they will be created">
          <Rows
            rows={plan.items.map((i) =>
              i.unsupported
                ? { dn: i.dn, tone: 'bad', tag: `${i.unsupported}, not imported` }
                : i.warnings.length
                  ? { dn: i.dn, tone: 'warn', tag: i.warnings.join('; ') }
                  : { dn: i.dn, tone: 'new', tag: 'new' },
            )}
          />
        </Box>
        {plan.leftOut.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted">
              {plural(plan.leftOut.length, 'server-managed attribute', 'server-managed attributes')}{' '}
              left out: {plan.leftOut.join(', ')}
            </summary>
            <p className="mt-1 text-muted">
              The server sets these itself and refuses them on create: NO-USER-MODIFICATION or a
              non-user usage in the schema.
            </p>
          </details>
        )}
        {plan.passwords > 0 && (
          <Banner tone="warn">
            Passwords are never imported: users are created without one, set it later with Set
            password.
          </Banner>
        )}
        <Banner tone="info">
          Entries with warnings are tried as they are; the server decides. An entry that already
          exists is skipped, never overwritten.
        </Banner>
        <div className="flex items-center gap-2">
          <Button onClick={() => setRecords(null)}>Back</Button>
          <span className="flex-1 text-right text-xs text-muted">{why}</span>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!!why} onClick={() => void start(plan.items)}>
            Import {plural(supported.length, 'entry', 'entries')}
          </Button>
        </div>
      </div>
    )
  } else if (running) {
    title = 'Importing'
    description = `${progress} of ${supported.length}`
    body = (
      <div className="space-y-3">
        <div
          role="progressbar"
          aria-label="Import progress"
          aria-valuemin={0}
          aria-valuemax={supported.length}
          aria-valuenow={progress}
          className="h-1.5 overflow-hidden rounded-full bg-panel"
        >
          <div
            className="h-full bg-accent"
            style={{ width: `${(100 * progress) / Math.max(supported.length, 1)}%` }}
          />
        </div>
        <Chips
          keep
          chips={[
            [count('created'), 'created', 'created', 'ok'],
            [count('exists'), 'already existed', 'already existed'],
            [count('failed'), 'failed', 'failed', 'danger'],
          ]}
        />
        <div className="rounded-md border border-border">
          <Rows
            rows={[
              ...all.slice(-8).map(([dn, o]) => outcomeRow(dn, o)),
              ...(current ? [{ dn: current, tone: 'wait' as const, tag: 'creating…' }] : []),
            ]}
          />
        </div>
        <p className="text-xs text-muted">
          One entry at a time, parents first. A failure does not stop the run; entries below a
          failed one are skipped.
        </p>
        <div className="flex justify-end">
          <Button
            disabled={stopping}
            onClick={() => {
              stop.current = true
              setStopping(true)
            }}
          >
            Stop after this entry
          </Button>
        </div>
      </div>
    )
  } else {
    title = 'Import finished'
    description = to || ws.conn
    const failed = failedLDIF(plan, outcomes)
    const created = all.filter(([, o]) => o.kind === 'created').map(([dn]) => dn)
    // Plan order is by depth: the first created entry is the topmost.
    const top = plan.items.find((i) => outcomes.get(i.dn)?.kind === 'created')?.dn
    const failures = all.filter(([, o]) => o.kind === 'failed')
    const skipped = all.filter(([, o]) => o.kind !== 'failed' && o.kind !== 'created')
    body = (
      <div className="space-y-3">
        {ended ? <Banner tone="danger">The import stopped: {errorMessage(ended)}</Banner> : null}
        <Chips
          keep
          chips={[
            [count('created'), 'created', 'created', 'ok'],
            [count('exists'), 'already existed', 'already existed'],
            [count('failed'), 'failed', 'failed', 'danger'],
            [count('not-imported'), 'not imported', 'not imported', 'warn'],
            [count('unsupported'), 'not supported', 'not supported'],
          ]}
        />
        {failures.length > 0 && (
          <Box title="Failed">
            <Rows rows={failures.map(([dn, o]) => outcomeRow(dn, o))} />
          </Box>
        )}
        {skipped.length > 0 && (
          <Box title="Skipped">
            <Rows rows={skipped.map(([dn, o]) => outcomeRow(dn, o))} />
          </Box>
        )}
        {failed && (
          <p className="text-xs text-muted">
            Copy failed as LDIF holds the failed and not imported records. Fix them and import that
            again.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {failed && (
            <CopyButton text={failed} label="Copy failed as LDIF" size="md" variant="default">
              Copy failed as LDIF
            </CopyButton>
          )}
          {created.length > 0 && (
            <CopyButton
              text={created.join('\n')}
              label="Copy created DNs"
              size="md"
              variant="default"
            >
              Copy created DNs
            </CopyButton>
          )}
          <span className="flex-1" />
          <Button onClick={close}>Close</Button>
          {top && (
            <Button
              variant="primary"
              onClick={() => {
                ws.select(top)
                close()
              }}
            >
              Show {rdnDisplay(splitDN(top)[0] ?? top)}
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !running) close()
      }}
      title={title}
      description={description}
      wide
    >
      {body}
    </Dialog>
  )
}
