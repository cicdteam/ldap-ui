import { useState } from 'react'
import { load, save } from '../lib/storage'

/** State mirrored to localStorage under key (best effort). */
export function useStored<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => load(key, fallback))
  return [
    value,
    (v: T) => {
      setValue(v)
      save(key, v)
    },
  ]
}
