import { expect, it } from 'vitest'
import { stageOnce, stagingSettled } from './batch'

it('stageOnce runs one staging per key at a time; stagingSettled waits for them', async () => {
  let release!: (v: boolean) => void
  let runs = 0
  const stage = () => {
    runs++
    return new Promise<boolean>((r) => (release = r))
  }
  const first = stageOnce('k', stage)
  // A second commit while the first still reads gets the first's result.
  expect(stageOnce('k', stage)).toBe(first)
  expect(runs).toBe(1)
  let settled = false
  void stagingSettled().then(() => (settled = true))
  await Promise.resolve()
  expect(settled).toBe(false)
  release(true)
  await stagingSettled()
  expect(settled).toBe(true)
  expect(await first).toBe(true)
  // Once settled, the key runs again.
  void stageOnce('k', stage)
  expect(runs).toBe(2)
  release(false)
})

it('a failed staging settles too', async () => {
  const failed = stageOnce('bad', () => Promise.reject(new Error('read')))
  await expect(failed).rejects.toThrow('read')
  await expect(stagingSettled()).resolves.toEqual([])
})
