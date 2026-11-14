import { MutationObserver, QueryClient } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { batches } from '../../lib/batchStore'
import { applyKey } from '../batch'
import {
  ADD_TO_GROUP,
  ENTRY_ACTION,
  FOCUS_FILTER,
  FORMAT_FILTER,
  OPEN_REVIEW,
  RUN_SEARCH,
} from '../events'
import { addToGroup, batchActions, entryActions, filterActions } from './CommandPalette'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('lists the query bar actions and fires the events the bar listens for', () => {
  const win = new EventTarget()
  vi.stubGlobal('window', win)
  const fired: string[] = []
  for (const type of [FOCUS_FILTER, RUN_SEARCH, FORMAT_FILTER]) {
    win.addEventListener(type, (e) => fired.push(e.type))
  }
  expect(filterActions.map((a) => [a.label, a.shortcut])).toEqual([
    ['Focus the filter editor', '/'],
    ['Run search', 'Mod+Enter'],
    ['Format the filter', 'Shift+Alt+F'],
  ])
  for (const a of filterActions) a.run()
  expect(fired).toEqual([FOCUS_FILTER, RUN_SEARCH, FORMAT_FILTER])
})

it('lists the batch actions: review opens the dialog, undo and redo step the batch', () => {
  const win = new EventTarget()
  vi.stubGlobal('window', win)
  vi.stubGlobal('sessionStorage', undefined)
  const fired: string[] = []
  win.addEventListener(OPEN_REVIEW, (e) => fired.push(e.type))
  const acts = batchActions('palette', new QueryClient())
  const run = (id: string) => acts.find((a) => a.id === id)?.run()
  expect(acts.map((a) => [a.label, a.shortcut])).toEqual([
    ['Review changes', 'Mod+S'],
    ['Undo the last change', 'Mod+Z'],
    ['Redo', 'Mod+Shift+Z'],
  ])
  run('review')
  expect(fired).toEqual([OPEN_REVIEW])
  batches.stage('palette', 'uid=a,dc=x', { kind: 'add', attr: 'mail', value: 'z' })
  run('undo')
  expect(batches.get('palette')).toEqual([])
  run('redo')
  expect(batches.get('palette')).toHaveLength(1)
})

it('undo and redo wait while an apply is in flight', () => {
  vi.stubGlobal('sessionStorage', undefined)
  const qc = new QueryClient()
  const run = (id: string) =>
    batchActions('pending', qc)
      .find((a) => a.id === id)
      ?.run()
  batches.stage('pending', 'uid=a,dc=x', { kind: 'add', attr: 'mail', value: 'z' })
  const apply = new MutationObserver(qc, {
    mutationKey: applyKey('pending'),
    mutationFn: () => new Promise<never>(() => {}),
  })
  void apply.mutate()
  run('undo')
  expect(batches.get('pending')).toHaveLength(1)
  apply.reset()
  qc.getMutationCache().clear()
  run('undo')
  expect(batches.get('pending')).toEqual([])
})

it('lists the entry actions; rename and delete carry the staged hint', () => {
  const win = new EventTarget()
  vi.stubGlobal('window', win)
  const fired: string[] = []
  win.addEventListener(ENTRY_ACTION, (e) => fired.push((e as CustomEvent<string>).detail))
  const hint = 'Apply or discard 1 staged change first'
  expect(entryActions(hint).map((a) => [a.label, a.shortcut, a.disabled])).toEqual([
    ['New child entry', 'N', ''],
    ['Clone entry', 'C', ''],
    ['Rename/Move entry', 'R', hint],
    ['Delete entry', 'Delete', hint],
  ])
  // Set password shows where the entry can hold one; it never waits for the batch.
  expect(entryActions(hint, true).map((a) => [a.label, a.shortcut, a.disabled])).toEqual([
    ['New child entry', 'N', ''],
    ['Clone entry', 'C', ''],
    ['Rename/Move entry', 'R', hint],
    ['Set password…', 'P', ''],
    ['Delete entry', 'Delete', hint],
  ])
  for (const a of entryActions('', true)) a.run()
  expect(fired).toEqual(['new', 'clone', 'rename', 'password', 'delete'])
})

it('Add to group asks the inspector for its add field', () => {
  const win = new EventTarget()
  vi.stubGlobal('window', win)
  const fired: string[] = []
  win.addEventListener(ADD_TO_GROUP, (e) => fired.push(e.type))
  expect(addToGroup.label).toBe('Add to group…')
  addToGroup.run()
  expect(fired).toEqual([ADD_TO_GROUP])
})
