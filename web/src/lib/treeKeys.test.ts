import { describe, expect, it } from 'vitest'
import type { TreeRow } from './tree'
import { parentIndex, treeKey } from './treeKeys'

const row = (
  dn: string,
  label: string,
  depth: number,
  expandable = false,
  expanded = false,
): TreeRow => ({
  key: `entry:${dn}`,
  type: 'entry',
  dn,
  label,
  prefix: '',
  depth,
  expandable,
  expanded,
  kind: 'other',
})

// root (open) > people (open) > alice, bob ; groups (closed) ; services (closed)
const rows: TreeRow[] = [
  row('dc=x', 'dc=x', 0, true, true),
  row('ou=people,dc=x', 'people', 1, true, true),
  row('uid=alice,ou=people,dc=x', 'alice', 2),
  row('uid=bob,ou=people,dc=x', 'bob', 2),
  row('ou=groups,dc=x', 'groups', 1, true, false),
  row('ou=services,dc=x', 'services', 1, true, false),
]

describe('treeKey', () => {
  it('moves up and down within bounds', () => {
    expect(treeKey(rows, 0, 'ArrowDown', '')).toEqual({ focus: 1 })
    expect(treeKey(rows, 5, 'ArrowDown', '')).toEqual({ focus: 5 })
    expect(treeKey(rows, 0, 'ArrowUp', '')).toEqual({ focus: 0 })
    expect(treeKey(rows, 3, 'Home', '')).toEqual({ focus: 0 })
    expect(treeKey(rows, 0, 'End', '')).toEqual({ focus: 5 })
  })

  it('expands, enters, collapses and climbs', () => {
    expect(treeKey(rows, 4, 'ArrowRight', '')).toEqual({ expand: ['ou=groups,dc=x'] })
    expect(treeKey(rows, 1, 'ArrowRight', '')).toEqual({ focus: 2 })
    expect(treeKey(rows, 2, 'ArrowRight', '')).toBeNull()
    expect(treeKey(rows, 1, 'ArrowLeft', '')).toEqual({ collapse: 'ou=people,dc=x' })
    expect(treeKey(rows, 3, 'ArrowLeft', '')).toEqual({ focus: 1 })
    expect(treeKey(rows, 4, 'ArrowLeft', '')).toEqual({ focus: 0 })
  })

  it('activates with Enter and Space', () => {
    expect(treeKey(rows, 3, 'Enter', '')).toEqual({ activate: 3 })
    expect(treeKey(rows, 3, ' ', '')).toEqual({ activate: 3 })
  })

  it('expands all closed siblings with *', () => {
    expect(treeKey(rows, 1, '*', '')).toEqual({ expand: ['ou=groups,dc=x', 'ou=services,dc=x'] })
  })

  it('type-ahead starts after the focus and continues a buffer in place', () => {
    expect(treeKey(rows, 0, 'b', '')).toEqual({ focus: 3 })
    expect(treeKey(rows, 4, 's', '')).toEqual({ focus: 5 })
    expect(treeKey(rows, 5, 'g', '')).toEqual({ focus: 4 })
    expect(treeKey(rows, 4, 'r', 'g')).toEqual({ focus: 4 })
    expect(treeKey(rows, 0, 'z', '')).toBeNull()
  })

  it('ignores other keys and empty trees', () => {
    expect(treeKey(rows, 0, 'Tab', '')).toBeNull()
    expect(treeKey([], 0, 'ArrowDown', '')).toBeNull()
    expect(treeKey(rows, 99, 'ArrowDown', '')).toEqual({ focus: 0 })
  })
})

describe('parentIndex', () => {
  it('finds the nearest shallower row', () => {
    expect(parentIndex(rows, 3)).toBe(1)
    expect(parentIndex(rows, 4)).toBe(0)
    expect(parentIndex(rows, 0)).toBe(-1)
  })
})
