import { BASE } from './fixture'
import { attrRow, exact, openEntry, palette } from './helpers'
import { expect, test, type Locator } from './test'

// A demo group with two members; nothing writes to it.
const GROUP = `cn=staff,ou=groups,${BASE}`
const MEMBERS = [`cn=devs,ou=groups,${BASE}`, `uid=user001,ou=people,${BASE}`]

/** NaN for an element not shown, so no comparison passes on it. */
const height = async (loc: Locator) => (await loc.boundingBox())?.height ?? NaN

test('compact density tightens rows, icon buttons, fields and the status bar; it survives a reload', async ({
  page,
}) => {
  await openEntry(page, 'demo', GROUP)
  const row = attrRow(page, 'cn')
  const button = page.getByRole('button', exact('Refresh tree'))
  const status = page.getByRole('contentinfo', { name: 'Connection status' })
  // Fields shrink too: Base, in the query bar's popover.
  const scope = page.getByTitle('Search base, scope and columns')
  const base = page.getByLabel('Base', { exact: true })
  const member = (dn: string) =>
    page.getByRole('region', exact('Members')).locator(`[data-ref="${dn}"]`)

  const comfortable = {
    row: await height(row),
    button: await height(button),
    status: await height(status),
  }
  await scope.click()
  const comfortableBase = await height(base)
  await page.keyboard.press('Escape')
  // Edit on: member rows carry a Remove button.
  await page.getByRole('button', exact('Edit')).click()
  await page.getByRole('tab', exact('Membership')).click()
  const comfortableMember = await height(member(MEMBERS[0]))

  await page.getByRole('button', exact('Toggle density')).click()
  await expect.poll(() => height(member(MEMBERS[0]))).toBeLessThan(comfortableMember)
  // Each row's button stays inside its row, so no hit area covers the next one's.
  for (const dn of MEMBERS) {
    const box = (await member(dn).boundingBox())!
    const remove = (await member(dn)
      .getByRole('button', exact(`Remove ${dn}`))
      .boundingBox())!
    expect(remove.y).toBeGreaterThanOrEqual(box.y)
    expect(remove.y + remove.height).toBeLessThanOrEqual(box.y + box.height)
  }
  // Icon buttons follow the row height, and the status bar still fits the window.
  await expect.poll(() => height(button)).toBeLessThan(comfortable.button)
  await expect.poll(() => height(status)).toBeLessThan(comfortable.status)
  const bar = (await status.boundingBox())!
  expect(bar.y + bar.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  await scope.click()
  await expect.poll(() => height(base)).toBeLessThan(comfortableBase)
  await page.keyboard.press('Escape')
  const compactStatus = await height(status)

  // A reload keeps compact; it also ends Edit, so the attribute rows are as first measured.
  await page.reload()
  await page.getByRole('tab', exact('Attributes')).click()
  await expect.poll(() => height(row)).toBeLessThan(comfortable.row)
  expect(await height(status)).toBe(compactStatus)

  // The palette's command switches back.
  await palette(page, 'Toggle compact rows')
  await page.keyboard.press('Enter')
  await expect.poll(() => height(status)).toBe(comfortable.status)
})
