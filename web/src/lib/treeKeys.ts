import type { TreeRow } from './tree'

// Keyboard model of the WAI-ARIA treeview pattern, as a pure function.

export interface TreeAction {
  focus?: number
  expand?: string[]
  collapse?: string
  activate?: number
}

export function parentIndex(rows: TreeRow[], i: number): number {
  for (let j = i - 1; j >= 0; j--) if (rows[j].depth < rows[i].depth) return j
  return -1
}

/** typeahead: characters typed just before key (reset by the caller after a pause). */
export function treeKey(
  rows: TreeRow[],
  focus: number,
  key: string,
  typeahead: string,
): TreeAction | null {
  if (rows.length === 0) return null
  const row = rows[focus]
  if (!row) return { focus: 0 }
  switch (key) {
    case 'ArrowDown':
      return { focus: Math.min(focus + 1, rows.length - 1) }
    case 'ArrowUp':
      return { focus: Math.max(focus - 1, 0) }
    case 'Home':
      return { focus: 0 }
    case 'End':
      return { focus: rows.length - 1 }
    case 'ArrowRight':
      if (row.expandable && !row.expanded) return { expand: [row.dn] }
      if (row.expanded && rows[focus + 1]?.depth === row.depth + 1) return { focus: focus + 1 }
      return null
    case 'ArrowLeft': {
      if (row.expanded) return { collapse: row.dn }
      const p = parentIndex(rows, focus)
      return p >= 0 ? { focus: p } : null
    }
    case 'Enter':
    case ' ':
      return { activate: focus }
    case '*': {
      const parent = parentIndex(rows, focus)
      const dns = rows
        .filter(
          (r, i) =>
            r.depth === row.depth && parentIndex(rows, i) === parent && r.expandable && !r.expanded,
        )
        .map((r) => r.dn)
      return dns.length ? { expand: dns } : null
    }
  }
  if (key.length !== 1 || !/\S/.test(key)) return null
  const q = (typeahead + key).toLowerCase()
  // A fresh search starts after the focus; a continued one may stay on it.
  const start = typeahead ? 0 : 1
  for (let k = start; k < rows.length + start; k++) {
    const i = (focus + k) % rows.length
    if (rows[i].label.toLowerCase().startsWith(q)) return { focus: i }
  }
  return null
}
